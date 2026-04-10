import { analyzeCodebase } from './analyzer';
import { calculateCodeCoverage } from './coverageService';
import { ensureTestingFramework } from './frameworkSetup';
import { rateTestQuality } from './qualityRater';
import { generateReport } from './reportGenerator';
import { runTests } from './testRunner';
import { generateAllTests } from './testGenerator';
import { CodebaseContext, EngineError, ExistingTest, ScannedFunction, TestCaseResult } from './types';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, '');
}

interface PipelineResult {
    coverage: number;
    totalTests: number;
    passed: number;
    failed: number;
    skipped: number;
    reportPath?: string;
    reportMarkdown?: string;
    reportJson?: unknown;
    qualityByTest: Array<{
        testName: string;
        filePath: string;
        status: 'pass' | 'fail' | 'skip';
        qualityScore: number;
        qualityReason: string;
        timestamp: string;
        errorMessage?: string;
    }>;
    averageQualityScore: number;
    analysisSummary: {
        totalFiles: number;
        totalFunctions: number;
        totalClasses: number;
        totalTests: number;
        detectedLanguages: string[];
    };
    logs: string[];
}

async function extractScannedFunctions(context: CodebaseContext): Promise<ScannedFunction[]> {
    const functions: ScannedFunction[] = [];

    for (const file of context.files) {
        if (file.isTestFile) continue;

        const absolutePath = path.join(context.rootPath, file.relativePath);
        let sourceText: string;
        try {
            sourceText = await fs.readFile(absolutePath, 'utf8');
        } catch {
            continue;
        }

        const lines = sourceText.split('\n');
        const functionSymbols = file.symbols.filter((s) => s.kind === 'function');

        for (const symbol of functionSymbols) {
            const startIdx = symbol.line - 1;
            if (startIdx < 0 || startIdx >= lines.length) continue;

            let endIdx: number;

            if (file.language === 'python') {
                const baseIndent = (lines[startIdx].match(/^\s*/) ?? [''])[0].length;
                endIdx = startIdx + 1;
                while (endIdx < lines.length) {
                    if (lines[endIdx].trim() !== '') {
                        const indent = (lines[endIdx].match(/^\s*/) ?? [''])[0].length;
                        if (indent <= baseIndent) break;
                    }
                    endIdx++;
                }
            } else {
                let braceCount = 0;
                let foundBrace = false;
                endIdx = startIdx;
                while (endIdx < lines.length && endIdx < startIdx + 200) {
                    for (const ch of lines[endIdx]) {
                        if (ch === '{') { braceCount++; foundBrace = true; }
                        if (ch === '}') braceCount--;
                    }
                    endIdx++;
                    if (foundBrace && braceCount <= 0) break;
                }
            }

            const code = lines.slice(startIdx, endIdx).join('\n');
            if (code.trim().length > 0) {
                functions.push({
                    functionName: symbol.name,
                    functionCode: code,
                    filePath: absolutePath,
                });
            }
        }
    }

    return functions;
}

export async function runPipeline(projectDir: string): Promise<PipelineResult> {
    const logs: string[] = [];

    try {
        logs.push('Step 1: Analyzing codebase...');
        const context = await analyzeCodebase(projectDir);
        logs.push(`Scanned ${context.summary.totalFiles} source file(s).`);
        logs.push(`Detected language(s): ${context.detectedLanguages.join(', ') || 'none'}.`);
        logs.push(`Discovered ${context.summary.totalFunctions} function(s) and ${context.summary.totalClasses} class(es).`);

        logs.push('Step 2: Ensuring a test framework is available...');
        const framework = await ensureTestingFramework(projectDir, context);
        logs.push(...framework.logs);

        if (context.testFiles.length === 0) {
            logs.push('Step 3: No test files detected. Generating tests using AI...');
            try {
                const scannedFunctions = await extractScannedFunctions(context);
                logs.push(`Found ${scannedFunctions.length} exported function(s) to generate tests for.`);

                if (scannedFunctions.length > 0) {
                    const existingTests: ExistingTest[] = [];
                    const generatedTests = await generateAllTests(scannedFunctions, projectDir, existingTests);
                    logs.push(`Successfully generated ${generatedTests.length} test file(s).`);
                } else {
                    logs.push('No testable functions found; skipping test generation.');
                }
            } catch (genError: unknown) {
                const message = genError instanceof Error ? genError.message : String(genError);
                logs.push(`Warning: Test generation failed (${stripAnsi(message)}). Proceeding without generated tests.`);
            }
        }

        logs.push('Step 4: Running tests...');
        const testExecution = await runTests(projectDir, framework.framework);
        logs.push(...testExecution.logs);

        logs.push('Step 5: Computing quality scores for each test...');
        const enrichedResults: TestCaseResult[] = testExecution.testCases.map((testCase: TestCaseResult) => {
            const quality = rateTestQuality(testCase.testCode ?? '', testCase);
            return {
                ...testCase,
                qualityScore: quality.score,
                qualityReason: quality.reason,
            };
        });

        logs.push('Step 6: Generating test report artifacts...');
        const reportPath = await generateReport(enrichedResults, projectDir);
        logs.push(`Report written to: ${reportPath}`);

        let reportMarkdown = '';
        let reportJson: unknown;
        try {
            reportMarkdown = await fs.readFile(reportPath, 'utf8');
        } catch {
            logs.push('Warning: Unable to read report markdown for API response preview.');
        }

        try {
            const reportJsonPath = reportPath.replace(/\.md$/i, '.json');
            const reportJsonText = await fs.readFile(reportJsonPath, 'utf8');
            reportJson = JSON.parse(reportJsonText) as unknown;
        } catch {
            logs.push('Warning: Unable to read report JSON for API response download.');
        }

        const qualityByTest = enrichedResults.map((result: TestCaseResult) => ({
            testName: result.testName,
            filePath: result.filePath,
            status: result.status,
            qualityScore: result.qualityScore ?? 0,
            qualityReason: result.qualityReason ?? 'No quality rationale available.',
            timestamp: result.timestamp,
            errorMessage: result.errorMessage,
        }));

        const averageQualityScore = qualityByTest.length > 0
            ? qualityByTest.reduce((sum, item) => sum + item.qualityScore, 0) / qualityByTest.length
            : 0;

        logs.push('Step 7: Calculating code coverage...');
        const coverageFramework = framework.framework === 'jest' ? 'jest' : 'vitest';
        let coverage = {
            coveragePercent: 0,
            coveredLines: 0,
            totalLines: 0,
        };

        try {
            coverage = await calculateCodeCoverage(projectDir, coverageFramework);
            logs.push(`Coverage: ${coverage.coveragePercent}% (${coverage.coveredLines}/${coverage.totalLines} lines)`);
        } catch (coverageError: unknown) {
            if (coverageError instanceof EngineError) {
                logs.push(`Warning: Coverage step failed (${stripAnsi(coverageError.message)}). Returning 0% coverage.`);
            } else if (coverageError instanceof Error) {
                logs.push(`Warning: Coverage step failed (${stripAnsi(coverageError.message)}). Returning 0% coverage.`);
            } else {
                logs.push(`Warning: Coverage step failed (${stripAnsi(String(coverageError))}). Returning 0% coverage.`);
            }
        }

        return {
            coverage: coverage.coveragePercent,
            totalTests: testExecution.result.total,
            passed: testExecution.result.passed,
            failed: testExecution.result.failed,
            skipped: testExecution.result.skipped ?? 0,
            reportPath,
            reportMarkdown,
            reportJson,
            qualityByTest,
            averageQualityScore,
            analysisSummary: {
                totalFiles: context.summary.totalFiles,
                totalFunctions: context.summary.totalFunctions,
                totalClasses: context.summary.totalClasses,
                totalTests: context.summary.totalTests,
                detectedLanguages: context.detectedLanguages,
            },
            logs,
        };
    } catch (error: unknown) {
        if (error instanceof EngineError) {
            logs.push(`Error at stage "${error.stage}": ${stripAnsi(error.message)}`);
        } else if (error instanceof Error) {
            logs.push(`Unexpected error: ${stripAnsi(error.message)}`);
        } else {
            logs.push(`Unexpected error: ${stripAnsi(String(error))}`);
        }

        return {
            coverage: 0,
            totalTests: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            qualityByTest: [],
            averageQualityScore: 0,
            analysisSummary: {
                totalFiles: 0,
                totalFunctions: 0,
                totalClasses: 0,
                totalTests: 0,
                detectedLanguages: [],
            },
            logs,
        };
    }
}
