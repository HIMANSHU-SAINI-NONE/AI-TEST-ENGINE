import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TestCaseResult } from './types';

interface ReportPayload {
    generatedAt: string;
    summary: {
        total: number;
        passed: number;
        failed: number;
        skipped: number;
        averageQualityScore: number;
    };
    tests: TestCaseResult[];
}

function formatTimestampForFile(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join('');
}

function toMarkdown(report: ReportPayload): string {
    const lines: string[] = [];

    lines.push('# Test Report');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push(`- Total: ${report.summary.total}`);
    lines.push(`- Passed: ${report.summary.passed}`);
    lines.push(`- Failed: ${report.summary.failed}`);
    lines.push(`- Skipped: ${report.summary.skipped}`);
    lines.push(`- Average Quality Score: ${report.summary.averageQualityScore.toFixed(2)}`);
    lines.push('');
    lines.push('## Test Cases');
    lines.push('');
    lines.push('| Test Name | File Path | Status | Quality | Reason | Error | Timestamp |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');

    for (const test of report.tests) {
        const error = (test.errorMessage ?? '').replace(/\|/g, '\\|');
        const reason = (test.qualityReason ?? '').replace(/\|/g, '\\|');
        lines.push(
            `| ${test.testName} | ${test.filePath} | ${test.status} | ${test.qualityScore ?? '-'} | ${reason || '-'} | ${error || '-'} | ${test.timestamp} |`,
        );
    }

    lines.push('');
    return lines.join('\n');
}

export async function generateReport(testResults: TestCaseResult[], projectRoot: string = process.cwd()): Promise<string> {
    const generatedAt = new Date().toISOString();
    const reportDirectory = path.join(projectRoot, 'reports');
    await fs.mkdir(reportDirectory, { recursive: true });

    const total = testResults.length;
    const passed = testResults.filter((item: TestCaseResult) => item.status === 'pass').length;
    const failed = testResults.filter((item: TestCaseResult) => item.status === 'fail').length;
    const skipped = testResults.filter((item: TestCaseResult) => item.status === 'skip').length;
    const averageQualityScore = total === 0
        ? 0
        : testResults.reduce((sum: number, item: TestCaseResult) => sum + (item.qualityScore ?? 0), 0) / total;

    const reportPayload: ReportPayload = {
        generatedAt,
        summary: {
            total,
            passed,
            failed,
            skipped,
            averageQualityScore,
        },
        tests: testResults,
    };

    const timestamp = formatTimestampForFile(new Date());
    const jsonPath = path.join(reportDirectory, `test-report-${timestamp}.json`);
    const markdownPath = path.join(reportDirectory, `test-report-${timestamp}.md`);

    await fs.writeFile(jsonPath, JSON.stringify(reportPayload, null, 2), 'utf8');
    await fs.writeFile(markdownPath, toMarkdown(reportPayload), 'utf8');

    return markdownPath;
}
