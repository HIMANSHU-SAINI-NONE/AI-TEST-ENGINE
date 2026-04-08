import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { Dirent } from 'node:fs';
import {
    AnalyzedFile,
    CodebaseContext,
    EngineError,
    ModuleRelationship,
    SourceSymbol,
    SupportedLanguage,
} from './types';

const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
    'node_modules',
    '.git',
    '.next',
    'dist',
    'build',
    'coverage',
    'out',
]);

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SupportedLanguage>> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.java': 'java',
    '.go': 'go',
    '.rb': 'ruby',
};

function detectLanguage(filePath: string): SupportedLanguage {
    return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'unknown';
}

function isSourceFile(filePath: string): boolean {
    return detectLanguage(filePath) !== 'unknown';
}

function isTestFile(relativePath: string): boolean {
    return /(^|\/)(test|tests|__tests__)\//i.test(relativePath)
        || /\.(test|spec)\.(ts|tsx|js|jsx|py|java|go|rb)$/i.test(relativePath);
}

function compactWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function sanitizeComment(raw: string): string {
    return compactWhitespace(
        raw
            .replace(/^\/\*+/, '')
            .replace(/\*+\/$/, '')
            .split('\n')
            .map((line: string) => line.replace(/^\s*\*?\s?/, '').replace(/^\s*\/\/\s?/, ''))
            .join(' '),
    );
}

function extractTsLeadingDocstring(sourceFile: ts.SourceFile, node: ts.Node, sourceText: string): string | undefined {
    const ranges = ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? [];
    if (ranges.length === 0) {
        return undefined;
    }

    const nearest = ranges[ranges.length - 1];
    return sanitizeComment(sourceText.slice(nearest.pos, nearest.end));
}

function extractTopTsComment(sourceText: string): string | undefined {
    const match = sourceText.match(/^\s*(\/\*[\s\S]*?\*\/|\/\/.*(?:\r?\n\/\/.*)*)/);
    if (!match) {
        return undefined;
    }

    const normalized = sanitizeComment(match[1]);
    return normalized.length > 0 ? normalized : undefined;
}

function getScriptKind(filePath: string): ts.ScriptKind {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.tsx') {
        return ts.ScriptKind.TSX;
    }
    if (extension === '.jsx') {
        return ts.ScriptKind.JSX;
    }
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
        return ts.ScriptKind.JS;
    }

    return ts.ScriptKind.TS;
}

function extractTsJsMetadata(filePath: string, sourceText: string): {
    symbols: SourceSymbol[];
    moduleRelationships: ModuleRelationship;
    moduleDocstring?: string;
} {
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
    const symbols: SourceSymbol[] = [];
    const imports = new Set<string>();
    const exports = new Set<string>();

    const addSymbol = (name: string, kind: 'function' | 'class', node: ts.Node): void => {
        const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const docstring = extractTsLeadingDocstring(sourceFile, node, sourceText);
        symbols.push({
            name,
            kind,
            line: location.line + 1,
            docstring,
        });
    };

    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            imports.add(node.moduleSpecifier.text);
        }

        if (ts.isExportDeclaration(node)) {
            if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                exports.add(node.moduleSpecifier.text);
            }
            if (node.exportClause && ts.isNamedExports(node.exportClause)) {
                for (const item of node.exportClause.elements) {
                    exports.add(item.name.text);
                }
            }
        }

        if (ts.isExportAssignment(node)) {
            exports.add('default');
        }

        if (ts.isFunctionDeclaration(node) && node.name) {
            addSymbol(node.name.text, 'function', node);
            if (node.modifiers?.some((item: ts.ModifierLike) => item.kind === ts.SyntaxKind.ExportKeyword)) {
                exports.add(node.name.text);
            }
        }

        if (ts.isClassDeclaration(node) && node.name) {
            addSymbol(node.name.text, 'class', node);
            if (node.modifiers?.some((item: ts.ModifierLike) => item.kind === ts.SyntaxKind.ExportKeyword)) {
                exports.add(node.name.text);
            }
        }

        if (ts.isVariableStatement(node)) {
            const isExported = node.modifiers?.some((item: ts.ModifierLike) => item.kind === ts.SyntaxKind.ExportKeyword) ?? false;
            for (const declaration of node.declarationList.declarations) {
                if (
                    ts.isIdentifier(declaration.name)
                    && declaration.initializer
                    && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
                ) {
                    addSymbol(declaration.name.text, 'function', declaration);
                    if (isExported) {
                        exports.add(declaration.name.text);
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return {
        symbols,
        moduleRelationships: {
            imports: Array.from(imports),
            exports: Array.from(exports),
        },
        moduleDocstring: extractTopTsComment(sourceText),
    };
}

function extractPythonModuleDocstring(lines: string[]): string | undefined {
    let index = 0;
    while (index < lines.length && lines[index].trim() === '') {
        index += 1;
    }

    const firstLine = lines[index]?.trim();
    if (!firstLine || !(firstLine.startsWith('"""') || firstLine.startsWith("'''"))) {
        return undefined;
    }

    const token = firstLine.startsWith('"""') ? '"""' : "'''";
    let chunk = firstLine.slice(3);

    if (chunk.endsWith(token)) {
        return compactWhitespace(chunk.slice(0, -3));
    }

    index += 1;
    while (index < lines.length) {
        const current = lines[index];
        if (current.includes(token)) {
            chunk += ` ${current.slice(0, current.indexOf(token))}`;
            return compactWhitespace(chunk);
        }
        chunk += ` ${current}`;
        index += 1;
    }

    return compactWhitespace(chunk);
}

function extractPythonDocstring(lines: string[], declarationLine: number): string | undefined {
    let index = declarationLine;
    while (index < lines.length) {
        const trimmed = lines[index].trim();
        if (trimmed === '') {
            index += 1;
            continue;
        }

        if (!(trimmed.startsWith('"""') || trimmed.startsWith("'''"))) {
            return undefined;
        }

        const token = trimmed.startsWith('"""') ? '"""' : "'''";
        let chunk = trimmed.slice(3);

        if (chunk.endsWith(token)) {
            return compactWhitespace(chunk.slice(0, -3));
        }

        index += 1;
        while (index < lines.length) {
            const current = lines[index];
            if (current.includes(token)) {
                chunk += ` ${current.slice(0, current.indexOf(token))}`;
                return compactWhitespace(chunk);
            }
            chunk += ` ${current}`;
            index += 1;
        }

        return compactWhitespace(chunk);
    }

    return undefined;
}

function extractPythonMetadata(sourceText: string): {
    symbols: SourceSymbol[];
    moduleRelationships: ModuleRelationship;
    moduleDocstring?: string;
} {
    const lines = sourceText.split(/\r?\n/);
    const symbols: SourceSymbol[] = [];
    const imports = new Set<string>();
    const exports = new Set<string>();

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();

        const importMatch = line.match(/^import\s+([\w.,\s]+)/);
        if (importMatch) {
            importMatch[1].split(',').map((item: string) => item.trim()).filter(Boolean).forEach((item: string) => imports.add(item));
        }

        const fromImportMatch = line.match(/^from\s+([\w.]+)\s+import\s+(.+)$/);
        if (fromImportMatch) {
            imports.add(fromImportMatch[1]);
            fromImportMatch[2].split(',').map((item: string) => item.trim()).filter(Boolean).forEach((item: string) => exports.add(item));
        }

        const functionMatch = lines[i].match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (functionMatch) {
            symbols.push({
                name: functionMatch[1],
                kind: 'function',
                line: i + 1,
                docstring: extractPythonDocstring(lines, i + 1),
            });
        }

        const classMatch = lines[i].match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
        if (classMatch) {
            symbols.push({
                name: classMatch[1],
                kind: 'class',
                line: i + 1,
                docstring: extractPythonDocstring(lines, i + 1),
            });
        }
    }

    const allMatch = sourceText.match(/__all__\s*=\s*\[([^\]]+)\]/);
    if (allMatch) {
        allMatch[1]
            .split(',')
            .map((item: string) => item.replace(/["'\s]/g, '').trim())
            .filter(Boolean)
            .forEach((item: string) => exports.add(item));
    }

    return {
        symbols,
        moduleRelationships: {
            imports: Array.from(imports),
            exports: Array.from(exports),
        },
        moduleDocstring: extractPythonModuleDocstring(lines),
    };
}

function extractJavaDocComment(sourceText: string, symbolIndex: number): string | undefined {
    const prefix = sourceText.slice(0, symbolIndex);
    const matches = prefix.match(/\/\*\*[\s\S]*?\*\//g);
    if (!matches || matches.length === 0) {
        return undefined;
    }

    return sanitizeComment(matches[matches.length - 1]);
}

function extractJavaMetadata(sourceText: string): {
    symbols: SourceSymbol[];
    moduleRelationships: ModuleRelationship;
    moduleDocstring?: string;
} {
    const symbols: SourceSymbol[] = [];
    const imports = new Set<string>();

    const importMatches = sourceText.matchAll(/^\s*import\s+([\w.]+);/gm);
    for (const item of importMatches) {
        imports.add(item[1]);
    }

    const classMatches = sourceText.matchAll(/(^|\n)\s*(public\s+)?(abstract\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/g);
    for (const match of classMatches) {
        const name = match[4];
        const index = match.index ?? 0;
        const line = sourceText.slice(0, index).split(/\r?\n/).length;
        symbols.push({
            name,
            kind: 'class',
            line,
            docstring: extractJavaDocComment(sourceText, index),
        });
    }

    const methodMatches = sourceText.matchAll(/(^|\n)\s*(public|private|protected)?\s*(static\s+)?[A-Za-z0-9_<>\[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{]*\)\s*\{/g);
    for (const match of methodMatches) {
        const name = match[4];
        const index = match.index ?? 0;
        const line = sourceText.slice(0, index).split(/\r?\n/).length;
        symbols.push({
            name,
            kind: 'function',
            line,
            docstring: extractJavaDocComment(sourceText, index),
        });
    }

    return {
        symbols,
        moduleRelationships: {
            imports: Array.from(imports),
            exports: [],
        },
    };
}

function extractSimpleMetadata(sourceText: string): {
    symbols: SourceSymbol[];
    moduleRelationships: ModuleRelationship;
} {
    const symbols: SourceSymbol[] = [];
    const lines = sourceText.split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
        const classMatch = lines[i].match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (classMatch) {
            symbols.push({ name: classMatch[1], kind: 'class', line: i + 1 });
        }

        const functionMatch = lines[i].match(/\b(function|def|func)\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (functionMatch) {
            symbols.push({ name: functionMatch[2], kind: 'function', line: i + 1 });
        }
    }

    return {
        symbols,
        moduleRelationships: {
            imports: [],
            exports: [],
        },
    };
}

function parseFileByLanguage(filePath: string, sourceText: string, language: SupportedLanguage): {
    symbols: SourceSymbol[];
    moduleRelationships: ModuleRelationship;
    moduleDocstring?: string;
} {
    if (language === 'typescript' || language === 'javascript') {
        return extractTsJsMetadata(filePath, sourceText);
    }

    if (language === 'python') {
        return extractPythonMetadata(sourceText);
    }

    if (language === 'java') {
        return extractJavaMetadata(sourceText);
    }

    return extractSimpleMetadata(sourceText);
}

async function collectCandidateFiles(rootPath: string): Promise<string[]> {
    const files: string[] = [];

    async function walk(current: string): Promise<void> {
        const entries: Dirent[] = await fs.readdir(current, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_DIRECTORIES.has(entry.name)) {
                    await walk(fullPath);
                }
                continue;
            }

            if (!entry.isFile() || !isSourceFile(fullPath)) {
                continue;
            }

            files.push(fullPath);
        }
    }

    await walk(rootPath);
    return files;
}

export async function analyzeCodebase(rootPath: string): Promise<CodebaseContext> {
    const absoluteRoot = path.resolve(rootPath);

    const stat = await fs.stat(absoluteRoot).catch(() => {
        throw new EngineError('analyze-codebase', `Path does not exist: ${rootPath}`);
    });

    if (!stat.isDirectory()) {
        throw new EngineError('analyze-codebase', `Path is not a directory: ${rootPath}`);
    }

    const filesToAnalyze = await collectCandidateFiles(absoluteRoot);
    const files: AnalyzedFile[] = [];
    const languages = new Set<SupportedLanguage>();
    const languageCounts: Record<string, number> = {};

    for (const absoluteFilePath of filesToAnalyze) {
        const sourceText = await fs.readFile(absoluteFilePath, 'utf8');
        const relativePath = path.relative(absoluteRoot, absoluteFilePath).split(path.sep).join('/');
        const language = detectLanguage(absoluteFilePath);
        const metadata = parseFileByLanguage(absoluteFilePath, sourceText, language);

        languages.add(language);
        languageCounts[language] = (languageCounts[language] ?? 0) + 1;

        files.push({
            fileName: path.basename(absoluteFilePath),
            relativePath,
            language,
            isTestFile: isTestFile(relativePath),
            symbols: metadata.symbols,
            moduleRelationships: metadata.moduleRelationships,
            moduleDocstring: metadata.moduleDocstring,
        });
    }

    const testFiles = files.filter((file: AnalyzedFile) => file.isTestFile).map((file: AnalyzedFile) => file.relativePath);
    const totalFunctions = files
        .flatMap((file: AnalyzedFile) => file.symbols)
        .filter((symbol: SourceSymbol) => symbol.kind === 'function').length;
    const totalClasses = files
        .flatMap((file: AnalyzedFile) => file.symbols)
        .filter((symbol: SourceSymbol) => symbol.kind === 'class').length;

    return {
        rootPath: absoluteRoot,
        generatedAt: new Date().toISOString(),
        detectedLanguages: Array.from(languages),
        files,
        testFiles,
        summary: {
            totalFiles: files.length,
            totalTests: testFiles.length,
            totalFunctions,
            totalClasses,
            filesByLanguage: languageCounts,
        },
    };
}
