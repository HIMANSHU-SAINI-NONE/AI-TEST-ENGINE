'use client';

import { useState } from 'react';

interface EngineResult {
    coverage: number;
    totalTests: number;
    passed: number;
    failed: number;
    logs: string[];
}

interface ErrorResponse {
    error: string;
    logs: string[];
}

type ApiResponse = EngineResult | ErrorResponse;

function isErrorResponse(data: ApiResponse): data is ErrorResponse {
    return 'error' in data;
}

export default function HomePage() {
    const [file, setFile] = useState<File | null>(null);
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<EngineResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0] ?? null;
        if (f && f.name.endsWith('.zip')) {
            setFile(f);
            setError(null);
            setResult(null);
        } else if (f) {
            setError('Please upload a .zip file.');
        }
    };

    const handleSubmit = async () => {
        if (!file) return;

        setLoading(true);
        setError(null);
        setResult(null);

        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch('/api/run-engine', {
                method: 'POST',
                body: formData,
            });

            const data: ApiResponse = await response.json();

            if (!response.ok || isErrorResponse(data)) {
                const errMsg = isErrorResponse(data) ? data.error : 'Unknown error.';
                setError(errMsg);
                return;
            }

            setResult(data);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(`Failed to connect to the server: ${msg}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="container">
            <h1>AI Test Engineer</h1>
            <p className="subtitle">Upload your project (.zip) and we will generate tests for you</p>

            <div className="upload-box">
                <label htmlFor="zip-upload">Choose a .zip file:</label>
                <input
                    type="file"
                    accept=".zip"
                    onChange={onInputChange}
                    id="zip-upload"
                />

                {file && (
                    <p className="file-name">Selected: {file.name} ({(file.size / 1024).toFixed(1)} KB)</p>
                )}

                <br />

                <button
                    className="run-btn"
                    onClick={handleSubmit}
                    disabled={!file || loading}
                >
                    {loading ? 'Running...' : 'Run Tests'}
                </button>
            </div>

            {loading && (
                <p className="loading-msg">Please wait, analyzing your code...</p>
            )}

            {error && (
                <div className="error-box">
                    <b>Error:</b> {error}
                </div>
            )}

            {result && (
                <div className="results">
                    <h2>Results</h2>

                    <div className="stats">
                        <div className="stat">
                            <span className="stat-number">{result.coverage}%</span>
                            <span>Coverage</span>
                        </div>
                        <div className="stat">
                            <span className="stat-number">{result.totalTests}</span>
                            <span>Total Tests</span>
                        </div>
                        <div className="stat">
                            <span className="stat-number green">{result.passed}</span>
                            <span>Passed</span>
                        </div>
                        <div className="stat">
                            <span className="stat-number red">{result.failed}</span>
                            <span>Failed</span>
                        </div>
                    </div>

                    <div className="coverage-bar">
                        <div className="coverage-fill" style={{ width: `${Math.min(result.coverage, 100)}%` }}></div>
                    </div>

                    {result.logs.length > 0 && (
                        <div className="logs">
                            <h3>Logs</h3>
                            <pre>
                                {result.logs.map((line, i) => (
                                    <div key={i}>{line}</div>
                                ))}
                            </pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
