import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as fsSync from 'node:fs';
import { CodebaseContext, EngineError } from './types';

interface PackageJson {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

interface FrameworkSetupResult {
    framework: string;
    wasConfigured: boolean;
    logs: string[];
}

function hasFrameworkBinary(projectRoot: string, framework: string): boolean {
    const binaryName = process.platform === 'win32' ? `${framework}.cmd` : framework;
    return pathExists(path.join(projectRoot, 'node_modules', '.bin', binaryName));
}

function detectTestingFramework(pkg: PackageJson): string | null {
    const allDependencies = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
    };

    const frameworkPackages = ['vitest', 'jest', 'mocha', 'ava', 'uvu', 'pytest', 'junit'];
    for (const name of frameworkPackages) {
        if (allDependencies[name]) {
            return name;
        }
    }

    return null;
}

function isSupportedRunner(framework: string): boolean {
    return framework === 'vitest' || framework === 'jest';
}

function shouldUseVitest(context: CodebaseContext): boolean {
    return context.detectedLanguages.includes('typescript') || context.detectedLanguages.includes('javascript');
}

function writeDefaultVitestConfig(): string {
    return [
        "import { defineConfig } from 'vitest/config';",
        '',
        'export default defineConfig({',
        '    test: {',
        "        include: ['**/*.{test,spec}.{ts,tsx,js,jsx}'],",
        "        coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] },",
        '    },',
        '});',
        '',
    ].join('\n');
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            shell: true,
            env: process.env,
        });

        let stderr = '';

        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on('error', (error: Error) => {
            reject(error);
        });

        child.on('close', (code: number | null) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(stderr.trim() || `Install command failed with exit code ${code ?? 'unknown'}.`));
        });
    });
}

function resolvePackageManager(projectRoot: string): { command: string; args: string[] } {
    if (pathExists(path.join(projectRoot, 'pnpm-lock.yaml'))) {
        return { command: 'pnpm', args: ['install'] };
    }

    if (pathExists(path.join(projectRoot, 'yarn.lock'))) {
        return { command: 'yarn', args: ['install'] };
    }

    return {
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['install'],
    };
}

function pathExists(targetPath: string): boolean {
    try {
        const stat = fsSync.statSync(targetPath);
        return Boolean(stat);
    } catch {
        return false;
    }
}

export async function ensureTestingFramework(projectRoot: string, context: CodebaseContext): Promise<FrameworkSetupResult> {
    const packagePath = path.join(projectRoot, 'package.json');
    const packageExists = pathExists(packagePath);

    if (!packageExists || !shouldUseVitest(context)) {
        return {
            framework: 'unknown',
            wasConfigured: false,
            logs: ['Skipped framework setup because no JavaScript/TypeScript package project was detected.'],
        };
    }

    const logs: string[] = [];
    const packageRaw = await fs.readFile(packagePath, 'utf8');
    const parsed = JSON.parse(packageRaw) as PackageJson;
    const existingFramework = detectTestingFramework(parsed);
    const installCommand = resolvePackageManager(projectRoot);

    if (existingFramework && isSupportedRunner(existingFramework)) {
        logs.push('Detected existing testing framework in package.json; reusing current setup.');

        let packageModified = false;

        // Ensure @vitest/coverage-v8 is present since the test runner always uses --coverage
        if (existingFramework === 'vitest') {
            const hasCoverageDep = Boolean(
                parsed.devDependencies?.['@vitest/coverage-v8'] || parsed.dependencies?.['@vitest/coverage-v8'],
            );

            if (!hasCoverageDep) {
                parsed.devDependencies = parsed.devDependencies ?? {};
                parsed.devDependencies['@vitest/coverage-v8'] = parsed.devDependencies.vitest ?? '^3.2.4';
                await fs.writeFile(packagePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
                logs.push('Added missing @vitest/coverage-v8 to devDependencies for coverage support.');
                packageModified = true;
            }
        }

        const needsInstall = packageModified
            || !pathExists(path.join(projectRoot, 'node_modules'))
            || !hasFrameworkBinary(projectRoot, existingFramework);

        if (needsInstall) {
            await runCommand(installCommand.command, installCommand.args, projectRoot);
            logs.push(`Installed project dependencies using ${installCommand.command} to ensure ${existingFramework} is available.`);
        }

        return { framework: existingFramework, wasConfigured: false, logs };
    }

    if (existingFramework && !isSupportedRunner(existingFramework)) {
        logs.push(`Detected ${existingFramework}, which is unsupported by this engine; configuring Vitest fallback.`);
    }

    parsed.devDependencies = parsed.devDependencies ?? {};
    parsed.scripts = parsed.scripts ?? {};

    parsed.devDependencies.vitest = parsed.devDependencies.vitest ?? '^3.2.4';
    parsed.devDependencies['@vitest/coverage-v8'] = parsed.devDependencies['@vitest/coverage-v8'] ?? '^3.2.4';
    parsed.scripts.test = parsed.scripts.test ?? 'vitest run';
    parsed.scripts['test:coverage'] = parsed.scripts['test:coverage'] ?? 'vitest run --coverage';

    await fs.writeFile(packagePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    logs.push('Configured Vitest dependencies and scripts in package.json.');

    const vitestConfigPath = path.join(projectRoot, 'vitest.config.ts');
    if (!pathExists(vitestConfigPath)) {
        await fs.writeFile(vitestConfigPath, writeDefaultVitestConfig(), 'utf8');
        logs.push('Created vitest.config.ts with default coverage settings.');
    }

    try {
        await runCommand(installCommand.command, installCommand.args, projectRoot);
        logs.push(`Installed test dependencies using ${installCommand.command}.`);
    } catch (error) {
        throw new EngineError(
            'framework-setup',
            `Framework configured but dependency installation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    return {
        framework: 'vitest',
        wasConfigured: true,
        logs,
    };
}
