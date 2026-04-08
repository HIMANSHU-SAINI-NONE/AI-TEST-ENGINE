import { analyzeCodebase } from './analyzer';
import { calculateCodeCoverage } from './coverageService';
import { ensureTestingFramework } from './frameworkSetup';
import { rateTestQuality } from './qualityRater';
import { generateReport } from './reportGenerator';
import { runTests } from './testRunner';
import { EngineError, TestCaseResult } from './types';
import * as fs from 'node:fs/promises';

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

        logs.push('Step 3: Running tests...');
        const testExecution = await runTests(projectDir, framework.framework);
        logs.push(...testExecution.logs);

        logs.push('Step 4: Computing quality scores for each test...');
        const enrichedResults: TestCaseResult[] = testExecution.testCases.map((testCase: TestCaseResult) => {
            const quality = rateTestQuality(testCase.testCode ?? '', testCase);
            return {
                ...testCase,
                qualityScore: quality.score,
                qualityReason: quality.reason,
            };
        });

        logs.push('Step 5: Generating test report artifacts...');
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

        logs.push('Step 6: Calculating code coverage...');
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
