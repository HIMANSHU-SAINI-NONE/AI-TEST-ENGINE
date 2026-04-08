import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { CoverageCalculationResult, EngineError } from './types';

const COVERAGE_TIMEOUT_MS = 60_000;

interface ProcessOutput {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

interface IstanbulFileCoverage {
    l?: Record<string, number>;
}

type IstanbulCoverageReport = Record<string, IstanbulFileCoverage>;

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

async function runInstall(projectDir: string): Promise<void> {
    const installer = detectPackageManager(projectDir);
    const output = await new Promise<ProcessOutput>((resolve, reject) => {
        const processHandle = spawn(installer.command, installer.args, {
            cwd: projectDir,
            shell: true,
            env: process.env,
        });

        let stdout = '';
        let stderr = '';

        processHandle.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        processHandle.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        processHandle.on('error', (error: Error) => {
            reject(error);
        });

        processHandle.on('close', (exitCode: number | null) => {
            resolve({ stdout, stderr, exitCode });
        });
    });

    if (output.exitCode !== 0) {
        const details = stripAnsi(output.stderr || output.stdout).trim();
        throw new EngineError('coverage', `Dependency installation failed: ${details || 'Unknown installation error.'}`);
    }
}

function resolveLocalRunnerPath(repoPath: string, framework: 'vitest' | 'jest'): string {
    const executable = process.platform === 'win32' ? `${framework}.cmd` : framework;
    return path.join(repoPath, 'node_modules', '.bin', executable);
}

function resolveRunnerCommand(repoPath: string, framework: 'vitest' | 'jest', args: string[]): { command: string; args: string[] } {
    const localRunner = resolveLocalRunnerPath(repoPath, framework);
    if (fsSync.existsSync(localRunner)) {
        return {
            command: localRunner,
            args,
        };
    }

    return {
        command: resolveNpxCommand(),
        args: [framework, ...args],
    };
}

async function runVitestWithCoverage(repoPath: string): Promise<ProcessOutput> {
    return new Promise<ProcessOutput>((resolve, reject) => {
        const commandSpec = resolveRunnerCommand(repoPath, 'vitest', ['run', '--coverage', '--reporter=json']);
        const processHandle = spawn(
            commandSpec.command,
            commandSpec.args,
            {
                cwd: repoPath,
                shell: true,
                env: process.env,
            },
        );

        let stdout = '';
        let stderr = '';

        processHandle.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        processHandle.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        const timeoutId = setTimeout(() => {
            processHandle.kill('SIGTERM');
            reject(new EngineError('coverage', 'Vitest coverage execution timed out after 60 seconds.'));
        }, COVERAGE_TIMEOUT_MS);

        processHandle.on('error', (error: Error) => {
            clearTimeout(timeoutId);
            reject(new EngineError('coverage', `Failed to start Vitest: ${error.message}`));
        });

        processHandle.on('close', (exitCode: number | null) => {
            clearTimeout(timeoutId);
            resolve({ stdout, stderr, exitCode });
        });
    });
}

async function runJestWithCoverage(repoPath: string): Promise<ProcessOutput> {
    return new Promise<ProcessOutput>((resolve, reject) => {
        const commandSpec = resolveRunnerCommand(repoPath, 'jest', ['--json', '--coverage']);
        const processHandle = spawn(
            commandSpec.command,
            commandSpec.args,
            {
                cwd: repoPath,
                shell: true,
                env: process.env,
            },
        );

        let stdout = '';
        let stderr = '';

        processHandle.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        processHandle.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        const timeoutId = setTimeout(() => {
            processHandle.kill('SIGTERM');
            reject(new EngineError('coverage', 'Jest coverage execution timed out after 60 seconds.'));
        }, COVERAGE_TIMEOUT_MS);

        processHandle.on('error', (error: Error) => {
            clearTimeout(timeoutId);
            reject(new EngineError('coverage', `Failed to start Jest: ${error.message}`));
        });

        processHandle.on('close', (exitCode: number | null) => {
            clearTimeout(timeoutId);
            resolve({ stdout, stderr, exitCode });
        });
    });
}

function calculateCoverage(report: IstanbulCoverageReport): CoverageCalculationResult {
    let totalLines = 0;
    let coveredLines = 0;

    for (const fileCoverage of Object.values(report)) {
        const lineHits: Record<string, number> | undefined = fileCoverage.l;
        if (!lineHits) {
            continue;
        }

        for (const hits of Object.values(lineHits)) {
            totalLines += 1;
            if (hits > 0) {
                coveredLines += 1;
            }
        }
    }

    const coveragePercent = totalLines === 0
        ? 0
        : Math.round((coveredLines / totalLines) * 10000) / 100;

    return {
        totalLines,
        coveredLines,
        coveragePercent,
    };
}

export async function calculateCodeCoverage(
    repoPath: string,
    framework: 'vitest' | 'jest' = 'vitest',
): Promise<CoverageCalculationResult> {
    let runResult: ProcessOutput = framework === 'jest'
        ? await runJestWithCoverage(repoPath)
        : await runVitestWithCoverage(repoPath);

    if (runResult.exitCode !== 0) {
        const cleanedError = stripAnsi(runResult.stderr || runResult.stdout).trim();
        if (isDependencyResolutionError(cleanedError)) {
            await runInstall(repoPath);
            runResult = framework === 'jest'
                ? await runJestWithCoverage(repoPath)
                : await runVitestWithCoverage(repoPath);
        }
    }

    if (runResult.exitCode !== 0) {
        const errorText = stripAnsi(runResult.stderr || runResult.stdout).trim()
            || `Coverage command failed with exit code ${runResult.exitCode}.`;
        const label = framework === 'jest' ? 'Jest' : 'Vitest';
        throw new EngineError('coverage', `${label} failed: ${errorText}`);
    }

    const coveragePath: string = path.join(repoPath, 'coverage', 'coverage-final.json');

    const coverageJsonRaw: string = await fs.readFile(coveragePath, 'utf8').catch(() => {
        throw new EngineError('coverage', `Coverage file does not exist: ${coveragePath}`);
    });

    let parsedReport: IstanbulCoverageReport;
    try {
        parsedReport = JSON.parse(coverageJsonRaw) as IstanbulCoverageReport;
    } catch {
        throw new EngineError('coverage', 'Coverage JSON is invalid and could not be parsed.');
    }

    return calculateCoverage(parsedReport);
}
