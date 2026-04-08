import { TestCaseResult, TestQualityRating } from './types';

function clampScore(score: number): number {
    return Math.max(1, Math.min(10, Math.round(score)));
}

function scoreAssertionDepth(testCode: string): number {
    const assertionCount = (testCode.match(/\bexpect\s*\(/g) ?? []).length;
    if (assertionCount >= 4) {
        return 2;
    }
    if (assertionCount >= 2) {
        return 1.5;
    }
    if (assertionCount >= 1) {
        return 1;
    }
    return 0;
}

function scoreEdgeCaseCoverage(testCode: string): number {
    const edgeHints = [
        /\bnull\b/i,
        /\bundefined\b/i,
        /\bempty\b/i,
        /\berror\b/i,
        /\bthrows?\b/i,
        /\bboundary\b/i,
        /\bnegative\b/i,
        /\bzero\b/i,
    ];

    const hits = edgeHints.filter((pattern: RegExp) => pattern.test(testCode)).length;
    if (hits >= 3) {
        return 2;
    }
    if (hits >= 1) {
        return 1;
    }
    return 0;
}

function scoreMockUsage(testCode: string): number {
    const hasMocking = /\bvi\.mock\b|\bjest\.mock\b|\bstub\b|\bspyOn\b/i.test(testCode);
    const hasOverMocking = (testCode.match(/\bvi\.mock\b|\bjest\.mock\b/gi) ?? []).length > 3;

    if (!hasMocking) {
        return 1;
    }

    return hasOverMocking ? 0.5 : 2;
}

function scoreTestNaming(testCode: string): number {
    const nameMatches = testCode.match(/\b(it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g) ?? [];
    if (nameMatches.length === 0) {
        return 0;
    }

    const meaningfulNames = nameMatches.filter((item: string) => {
        const words = item.replace(/\s+/g, ' ').split(' ');
        return words.length >= 5 && /should|when|returns?|throws?/i.test(item);
    }).length;

    if (meaningfulNames >= nameMatches.length) {
        return 2;
    }
    if (meaningfulNames > 0) {
        return 1;
    }

    return 0.5;
}

function scoreIndependence(testCode: string): number {
    const hasSharedState = /\bbeforeAll\b|\bafterAll\b|\bglobal\b|\bprocess\.env\b/i.test(testCode);
    const mutatesModuleState = /\bsetTimeout\b|\bDate\.now\b|\bMath\.random\b/i.test(testCode);

    if (hasSharedState && mutatesModuleState) {
        return 0;
    }
    if (hasSharedState || mutatesModuleState) {
        return 1;
    }
    return 2;
}

export function rateTestQuality(testCode: string, testResult: TestCaseResult): TestQualityRating {
    const safeCode = testCode ?? '';

    const assertionDepth = scoreAssertionDepth(safeCode);
    const edgeCoverage = scoreEdgeCaseCoverage(safeCode);
    const mockUsage = scoreMockUsage(safeCode);
    const testNaming = scoreTestNaming(safeCode);
    const independence = scoreIndependence(safeCode);

    let totalScore = assertionDepth + edgeCoverage + mockUsage + testNaming + independence;

    // Failed tests can still be useful, but reliability should reduce quality confidence.
    if (testResult.status === 'fail') {
        totalScore -= 1;
    }

    const score = clampScore(totalScore);

    const weakestDimension = [
        { label: 'assertion depth', value: assertionDepth },
        { label: 'edge case coverage', value: edgeCoverage },
        { label: 'mock strategy', value: mockUsage },
        { label: 'test naming', value: testNaming },
        { label: 'independence', value: independence },
    ].sort((a, b) => a.value - b.value)[0];

    const reason = score >= 8
        ? 'Strong test quality across coverage, structure, and reliability signals.'
        : `Quality limited by ${weakestDimension.label}; improve this area for better value.`;

    return { score, reason };
}
