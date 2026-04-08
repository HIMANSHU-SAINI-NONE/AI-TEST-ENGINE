import { analyzeCodebase } from './codebaseAnalyzer';
import { CodebaseScanResult } from './types';

export { analyzeCodebase };

export async function scanCodebase(repoPath: string): Promise<CodebaseScanResult> {
    const context = await analyzeCodebase(repoPath);

    return {
        files: context.files.map((file) => ({
            filePath: file.relativePath,
            functions: file.symbols
                .filter((symbol) => symbol.kind === 'function')
                .map((symbol) => ({ name: symbol.name, code: '' })),
            classes: file.symbols
                .filter((symbol) => symbol.kind === 'class')
                .map((symbol) => ({ name: symbol.name })),
            modules: [
                ...file.moduleRelationships.imports,
                ...file.moduleRelationships.exports,
            ],
        })),
        totalFiles: context.summary.totalFiles,
        totalFunctions: context.summary.totalFunctions,
    };
}
