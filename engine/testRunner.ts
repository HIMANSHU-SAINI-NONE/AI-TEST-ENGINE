// ─── Test Runner Module ───────────────────────────────────────────────
// Executes Vitest in the project directory and parses results.

import { spawn } from 'child_process';
import * as path from 'path';
import { TestResult, EngineError } from './types';

const TIMEOUT_MS = 60_000;

interface RunOutput {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

/**
 * Spawn a command and capture output with a timeout.
 */
function spawnWithTimeout(
    command: string,
    args: string[],
    cwd: string
): Promise<RunOutput> {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
            cwd,
            shell: true,
            env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        proc.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        const timer = setTimeout(() => {
            proc.kill('SIGTERM');
            reject(new EngineError('test-execution', `Test execution timed out after ${TIMEOUT_MS / 1000} seconds.`));
        }, TIMEOUT_MS);

        proc.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code });
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(new EngineError('test-execution', `Failed to spawn test process: ${err.message}`));
        });
    });
}

/**
 * Parse the Vitest JSON reporter output to extract test counts.
 */
function parseVitestJson(stdout: string): TestResult {
    // Vitest JSON reporter outputs a JSON object. We need to find it in stdout.
    // The JSON output may be preceded or followed by other text.
    const jsonMatch = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);

    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]) as {
                numTotalTests?: number;
                numPassedTests?: number;
                numFailedTests?: number;
                testResults?: Array<{
                    assertionResults?: Array<{ status: string }>;
                }>;
            };

            if (
                typeof parsed.numTotalTests === 'number' &&
                typeof parsed.numPassedTests === 'number' &&
                typeof parsed.numFailedTests === 'number'
            ) {
                return {
                    total: parsed.numTotalTests,
                    passed: parsed.numPassedTests,
                    failed: parsed.numFailedTests,
                };
            }

            // Fallback: count from testResults
            if (parsed.testResults) {
                let total = 0;
                let passed = 0;
                let failed = 0;

                for (const suite of parsed.testResults) {
                    if (suite.assertionResults) {
                        for (const assertion of suite.assertionResults) {
                            total++;
                            if (assertion.status === 'passed') passed++;
                            else failed++;
                        }
                    }
                }

                return { total, passed, failed };
            }
        } catch {
            // JSON parsing failed, fall through to regex
        }
    }

    // Fallback: parse text output for test counts
    const passMatch = stdout.match(/(\d+)\s+pass/i);
    const failMatch = stdout.match(/(\d+)\s+fail/i);

    const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
    const failed = failMatch ? parseInt(failMatch[1], 10) : 0;

    return {
        total: passed + failed,
        passed,
        failed,
    };
}

/**
 * Run Vitest in the project directory and return test results + logs.
 */
export async function runTests(
    projectDir: string
): Promise<{ result: TestResult; logs: string[] }> {
    const logs: string[] = [];

    logs.push(`Running tests in: ${projectDir}`);

    // Determine npx path based on OS
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

    const { stdout, stderr, exitCode } = await spawnWithTimeout(
        npxCmd,
        ['vitest', 'run', '--reporter=json', '--coverage'],
        projectDir
    );

    logs.push(`Test process exited with code: ${exitCode}`);

    if (stderr.trim().length > 0) {
        logs.push(`stderr: ${stderr.trim().substring(0, 2000)}`);
    }

    const result = parseVitestJson(stdout);

    logs.push(`Test summary: ${result.total} total, ${result.passed} passed, ${result.failed} failed`);

    return { result, logs };
}
