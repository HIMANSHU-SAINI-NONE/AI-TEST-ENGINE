export interface ExportedFunctionInfo {
    name: string;
    code: string;
}

export interface ExportedClassInfo {
    name: string;
}

export interface ScannedFileInfo {
    filePath: string;
    functions: ExportedFunctionInfo[];
    classes: ExportedClassInfo[];
    modules: string[];
}

export interface CodebaseScanResult {
    files: ScannedFileInfo[];
    totalFiles: number;
    totalFunctions: number;
}

export interface CoverageCalculationResult {
    totalLines: number;
    coveredLines: number;
    coveragePercent: number;
}

export type SupportedLanguage =
    | 'typescript'
    | 'javascript'
    | 'python'
    | 'java'
    | 'go'
    | 'ruby'
    | 'unknown';

export interface SourceSymbol {
    name: string;
    kind: 'function' | 'class';
    line: number;
    docstring?: string;
}

export interface ModuleRelationship {
    imports: string[];
    exports: string[];
}

export interface AnalyzedFile {
    fileName: string;
    relativePath: string;
    language: SupportedLanguage;
    isTestFile: boolean;
    symbols: SourceSymbol[];
    moduleRelationships: ModuleRelationship;
    moduleDocstring?: string;
}

export interface CodebaseContext {
    rootPath: string;
    generatedAt: string;
    detectedLanguages: SupportedLanguage[];
    files: AnalyzedFile[];
    testFiles: string[];
    summary: {
        totalFiles: number;
        totalTests: number;
        totalFunctions: number;
        totalClasses: number;
        filesByLanguage: Record<string, number>;
    };
}

export interface ScannedFunction {
    functionName: string;
    functionCode: string;
    filePath: string;
}

export interface ExistingTest {
    fileName: string;
    filePath: string;
}

export interface GeneratedTest {
    functionName: string;
    testFilePath: string;
    testCode: string;
}

export interface TestResult {
    total: number;
    passed: number;
    failed: number;
    skipped?: number;
}

export interface TestCaseResult {
    testName: string;
    filePath: string;
    status: 'pass' | 'fail' | 'skip';
    errorMessage?: string;
    timestamp: string;
    testCode?: string;
    qualityScore?: number;
    qualityReason?: string;
}

export interface TestQualityRating {
    score: number;
    reason: string;
}

export class EngineError extends Error {
    public readonly stage: string;

    public constructor(stage: string, message: string) {
        super(message);
        this.name = 'EngineError';
        this.stage = stage;
    }
}
