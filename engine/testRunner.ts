import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { EngineError, TestCaseResult, TestResult } from './types';

const TIMEOUT_MS = 60_000;

interface ProcessOutput {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

interface RawAssertionResult {
    title?: string;
    fullName?: string;
    status?: string;
    failureMessages?: string[];
}

interface RawSuiteResult {
    name?: string;
    status?: string;
    assertionResults?: RawAssertionResult[];
    testFilePath?: string;
    tasks?: RawSuiteResult[];
    errors?: string[];
}

interface RawVitestReport {
    numTotalTests?: number;
    numPassedTests?: number;
    numFailedTests?: number;
    numPendingTests?: number;
    testResults?: RawSuiteResult[];
}

function resolveNpxCommand(): string {
    return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function detectPackageManager(projectDir: string): { command: string; args: string[] } {
    if (fsSync.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) {
        return { command: 'pnpm', args: ['install'] };
    }

    if (fsSync.existsSync(path.join(projectDir, 'yarn.lock'))) {
        return { command: 'yarn', args: ['install'] };
    }

    return {
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['install'],
    };
}

function isDependencyResolutionError(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes('missing dependency')
        || normalized.includes('cannot find module')
        || normalized.includes('err_module_not_found')
        || normalized.includes("is not recognized as an internal or external command")
        || normalized.includes('module not found');
}

async function installProjectDependencies(projectDir: string): Promise<void> {
    const installer = detectPackageManager(projectDir);
    const output = await runCommand(installer.command, installer.args, projectDir);
    if (output.exitCode !== 0) {
        const details = stripAnsi(output.stderr || output.stdout).trim();
        throw new EngineError('test-execution', `Dependency installation failed: ${details || 'Unknown installation error.'}`);
    }
}

function runCommand(command: string, args: string[], cwd: string): Promise<ProcessOutput> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            shell: true,
            env: process.env,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        const timeoutId = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new EngineError('test-execution', 'Test execution timed out after 60 seconds.'));
        }, TIMEOUT_MS);

        child.on('error', (error: Error) => {
            clearTimeout(timeoutId);
            reject(new EngineError('test-execution', `Failed to spawn test process: ${error.message}`));
        });

        child.on('close', (exitCode: number | null) => {
            clearTimeout(timeoutId);
            resolve({ stdout, stderr, exitCode });
        });
    });
}

function toStatus(value: string | undefined): 'pass' | 'fail' | 'skip' {
    if (value === 'passed' || value === 'pass') {
        return 'pass';
    }
    if (value === 'skipped' || value === 'skip' || value === 'pending') {
        return 'skip';
    }
    return 'fail';
}

function parseReportPayload(stdout: string): RawVitestReport | null {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) {
        return null;
    }

    try {
        return JSON.parse(stdout.slice(start, end + 1)) as RawVitestReport;
    } catch {
        return null;
    }
}

function collectTestCases(
    suite: RawSuiteResult,
    defaultFilePath: string,
    timestamp: string,
): TestCaseResult[] {
    const filePath = suite.testFilePath ?? defaultFilePath;
    const results: TestCaseResult[] = [];

    if (suite.assertionResults && suite.assertionResults.length > 0) {
        for (const assertion of suite.assertionResults) {
            results.push({
                testName: assertion.fullName ?? assertion.title ?? suite.name ?? 'Unnamed test',
                filePath,
                status: toStatus(assertion.status),
                errorMessage: assertion.failureMessages?.join('\n') || undefined,
                timestamp,
            });
        }
    }

    if (suite.tasks && suite.tasks.length > 0) {
        for (const task of suite.tasks) {
            results.push(...collectTestCases(task, filePath, timestamp));
        }
    }

    if (results.length === 0 && suite.name) {
        // Vitest task trees sometimes provide only suite-level pass/fail data.
        results.push({
            testName: suite.name,
            filePath,
            status: toStatus(suite.status),
            errorMessage: suite.errors?.join('\n') || undefined,
            timestamp,
        });
    }

    return results;
}

async function attachTestCode(projectDir: string, testCases: TestCaseResult[]): Promise<void> {
    const uniqueFiles = Array.from(new Set(testCases.map((item: TestCaseResult) => item.filePath)));
    const codeCache = new Map<string, string>();

    for (const relativeOrAbsolutePath of uniqueFiles) {
        const resolvedPath = path.isAbsolute(relativeOrAbsolutePath)
            ? relativeOrAbsolutePath
            : path.join(projectDir, relativeOrAbsolutePath);

        try {
            const source = await fs.readFile(resolvedPath, 'utf8');
            codeCache.set(relativeOrAbsolutePath, source);
        } catch {
            // Missing source is non-fatal; quality scoring can still run with an empty string.
            codeCache.set(relativeOrAbsolutePath, '');
        }
    }

    for (const testCase of testCases) {
        testCase.testCode = codeCache.get(testCase.filePath) ?? '';
    }
}

function resolveTestCommand(framework: string): string[] {
    const normalized = framework.toLowerCase();
    if (normalized === 'vitest') {
        return ['vitest', 'run', '--reporter=json', '--coverage'];
    }

    if (normalized === 'jest') {
        return ['jest', '--json', '--coverage'];
    }

    throw new EngineError('test-execution', `Unsupported test framework: ${framework}. Supported: vitest, jest.`);
}

export async function runTests(
    projectDir: string,
    framework: string = 'vitest',
): Promise<{ result: TestResult; testCases: TestCaseResult[]; logs: string[] }> {
    const logs: string[] = [];
    logs.push(`Running tests in: ${projectDir}`);
    logs.push(`Selected framework: ${framework}`);

    const commandArgs = resolveTestCommand(framework);

    let output: ProcessOutput | null = null;
    let report: RawVitestReport | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        output = await runCommand(resolveNpxCommand(), commandArgs, projectDir);
        report = parseReportPayload(output.stdout);

        const stderrText = stripAnsi(output.stderr).trim();
        const stdoutText = stripAnsi(output.stdout).trim();

        logs.push(`Test process exited with code: ${output.exitCode ?? 'unknown'}${attempt === 1 ? ' (retry)' : ''}`);
        if (stderrText.length > 0) {
            logs.push(`stderr: ${stderrText.slice(0, 4000)}`);
        }

        if (output.exitCode === 0 || report) {
            break;
        }

        const errorText = stderrText || stdoutText || 'Test process failed without diagnostics.';
        const shouldRetry = attempt === 0 && isDependencyResolutionError(errorText);
        if (shouldRetry) {
            logs.push('Detected dependency resolution error during test run; installing dependencies and retrying once.');
            await installProjectDependencies(projectDir);
            continue;
        }

        throw new EngineError('test-execution', errorText);
    }

    if (!output) {
        throw new EngineError('test-execution', 'Test process did not produce any output.');
    }

    const timestamp = new Date().toISOString();

    let testCases: TestCaseResult[] = [];
    if (report?.testResults && report.testResults.length > 0) {
        for (const suite of report.testResults) {
            const suiteFile = suite.testFilePath ?? '';
            testCases.push(...collectTestCases(suite, suiteFile, timestamp));
        }
    }

    await attachTestCode(projectDir, testCases);

    const result: TestResult = {
        total: report?.numTotalTests ?? testCases.length,
        passed: report?.numPassedTests ?? testCases.filter((item: TestCaseResult) => item.status === 'pass').length,
        failed: report?.numFailedTests ?? testCases.filter((item: TestCaseResult) => item.status === 'fail').length,
        skipped: report?.numPendingTests ?? testCases.filter((item: TestCaseResult) => item.status === 'skip').length,
    };

    logs.push(
        `Test summary: ${result.total} total, ${result.passed} passed, ${result.failed} failed, ${result.skipped ?? 0} skipped`,
    );

    return { result, testCases, logs };
}
