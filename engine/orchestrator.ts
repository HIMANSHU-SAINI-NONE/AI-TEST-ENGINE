// ─── Orchestrator Module ──────────────────────────────────────────────
// Controls the full pipeline: validate → scan → detect tests → generate → run → coverage.

import { validateProject, scanSourceFiles, extractExportedFunctions, detectExistingTests } from './analyzer';
import { generateAllTests } from './testGenerator';
import { runTests } from './testRunner';
import { parseCoverage } from './coverageService';
import { EngineResult, EngineError, ScannedFunction } from './types';

/**
 * Run the complete AI Test Engineer pipeline.
 *
 * Steps:
 * 1. Validate project (package.json, Vitest)
 * 2. Scan source files and extract exported functions
 * 3. Detect existing test files
 * 4. Generate unit tests via LLaMA
 * 5. Run tests with Vitest
 * 6. Parse coverage results
 * 7. Return structured EngineResult
 */
export async function runPipeline(projectDir: string): Promise<EngineResult> {
    const logs: string[] = [];

    try {
        // ─── Step 1: Validate ────────────────────────────────────────────
        logs.push('Step 1: Validating project...');
        await validateProject(projectDir);
        logs.push('✓ Project validated. package.json found, Vitest detected.');

        // ─── Step 2: Scan source files ───────────────────────────────────
        logs.push('Step 2: Scanning source files...');
        const sourceFiles = await scanSourceFiles(projectDir);
        logs.push(`✓ Found ${sourceFiles.length} source file(s).`);

        // Extract exported functions from all source files
        const allFunctions: ScannedFunction[] = [];
        for (const filePath of sourceFiles) {
            const fns = await extractExportedFunctions(filePath);
            allFunctions.push(...fns);
        }
        logs.push(`✓ Extracted ${allFunctions.length} exported function(s).`);

        if (allFunctions.length === 0) {
            throw new EngineError('scan', 'No exported functions found in the project.');
        }

        // Log discovered functions
        for (const fn of allFunctions) {
            logs.push(`  → ${fn.functionName} (${fn.filePath})`);
        }

        // ─── Step 3: Detect existing tests ───────────────────────────────
        logs.push('Step 3: Detecting existing tests...');
        const existingTests = await detectExistingTests(projectDir);
        logs.push(`✓ Found ${existingTests.length} existing test file(s).`);

        // ─── Step 4: Generate tests ──────────────────────────────────────
        logs.push('Step 4: Generating unit tests...');
        const generatedTests = await generateAllTests(allFunctions, projectDir, existingTests);
        logs.push(`✓ Generated ${generatedTests.length} test file(s).`);

        for (const gt of generatedTests) {
            logs.push(`  → ${gt.testFilePath}`);
        }

        // ─── Step 5: Run tests ───────────────────────────────────────────
        logs.push('Step 5: Running tests with Vitest...');
        const { result: testResult, logs: testLogs } = await runTests(projectDir);
        logs.push(...testLogs);

        // ─── Step 6: Parse coverage ──────────────────────────────────────
        logs.push('Step 6: Parsing coverage report...');
        const coverageResult = await parseCoverage(projectDir);
        logs.push(
            `✓ Coverage: ${coverageResult.percentage}% (${coverageResult.coveredLines}/${coverageResult.totalLines} statements)`
        );

        // ─── Step 7: Return result ───────────────────────────────────────
        return {
            coverage: coverageResult.percentage,
            totalTests: testResult.total,
            passed: testResult.passed,
            failed: testResult.failed,
            logs,
        };
    } catch (error: unknown) {
        if (error instanceof EngineError) {
            logs.push(`✗ Error at stage "${error.stage}": ${error.message}`);
            return {
                coverage: 0,
                totalTests: 0,
                passed: 0,
                failed: 0,
                logs,
            };
        }

        const msg = error instanceof Error ? error.message : String(error);
        logs.push(`✗ Unexpected error: ${msg}`);
        return {
            coverage: 0,
            totalTests: 0,
            passed: 0,
            failed: 0,
            logs,
        };
    }
}
