'use client';

import { useState } from 'react';

interface QualityItem {
    testName: string;
    filePath: string;
    status: 'pass' | 'fail' | 'skip';
    qualityScore: number;
    qualityReason: string;
    timestamp: string;
    errorMessage?: string;
}

interface EngineResult {
    coverage: number;
    totalTests: number;
    passed: number;
    failed: number;
    skipped: number;
    reportPath?: string;
    reportMarkdown?: string;
    reportJson?: unknown;
    qualityByTest: QualityItem[];
    averageQualityScore: number;
    logs: string[];
}

// main page component
export default function HomePage() {
    // state variables
    let [file, setFile] = useState<any>(null);
    let [loading, setLoading] = useState(false);
    let [result, setResult] = useState<EngineResult | null>(null);
    let [error, setError] = useState<any>(null);

    // when user picks a file
    function handleFileChange(e: any) {
        let f = e.target.files[0];
        if (f && f.name.endsWith('.zip')) {
            setFile(f);
            setError(null);
            setResult(null);
        } else if (f) {
            setError('Please upload a .zip file.');
        }
    }

    function downloadTextFile(fileName: string, content: string, mimeType: string): void {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    function handleDownloadJson(): void {
        if (!result?.reportJson) {
            return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const jsonContent = JSON.stringify(result.reportJson, null, 2);
        downloadTextFile(`test-report-${timestamp}.json`, jsonContent, 'application/json');
    }

    function handleDownloadMarkdown(): void {
        if (!result?.reportMarkdown) {
            return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadTextFile(`test-report-${timestamp}.md`, result.reportMarkdown, 'text/markdown');
    }

    // when user clicks the button
    async function handleClick() {
        if (!file) {
            return; // no file selected
        }

        setLoading(true);
        setError(null);
        setResult(null);

        try {
            let formData = new FormData();
            formData.append('file', file);

            let response = await fetch('/api/run-engine', {
                method: 'POST',
                body: formData,
            });

            let data: EngineResult & { error?: string } = await response.json();

            // check if theres an error
            if (!response.ok || data.error) {
                if (data.error) {
                    setError(data.error);
                } else {
                    setError('Unknown error.');
                }
                return;
            }

            setResult(data);
            console.log("got result:", data);
        } catch (err: any) {
            console.log("error:", err);
            setError('Failed to connect to the server: ' + err.message);
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="container">
            <h1>AI Test Engineer</h1>
            <p className="subtitle">Upload your project (.zip) and we will generate tests for you</p>

            {/* file upload section */}
            <div className="upload-box">
                <label htmlFor="zip-upload">Choose a .zip file:</label>
                <input
                    type="file"
                    accept=".zip"
                    onChange={handleFileChange}
                    id="zip-upload"
                />

                {file != null && (
                    <p className="file-name">Selected: {file.name} ({(file.size / 1024).toFixed(1)} KB)</p>
                )}

                <br />

                <button
                    className="run-btn"
                    onClick={handleClick}
                    disabled={!file || loading}
                >
                    {loading ? 'Running...' : 'Run Tests'}
                </button>
            </div>

            {/* show loading message */}
            {loading == true && (
                <p className="loading-msg">Please wait, analyzing your code...</p>
            )}

            {/* show error if there is one */}
            {error != null && (
                <div className="error-box">
                    <b>Error:</b> {error}
                </div>
            )}

            {/* show results */}
            {result != null && (
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
                        <div className="stat">
                            <span className="stat-number">{(result.averageQualityScore ?? 0).toFixed(1)}</span>
                            <span>Avg Quality</span>
                        </div>
                    </div>

                    <div className="coverage-bar">
                        <div className="coverage-fill" style={{ width: result.coverage + '%' }}></div>
                    </div>

                    {/* show logs */}
                    {result.logs.length > 0 && (
                        <div className="logs">
                            <h3>Logs</h3>
                            <pre>
                                {result.logs.map(function(line: string, i: number) {
                                    return <div key={i}>{line}</div>
                                })}
                            </pre>
                        </div>
                    )}

                    {result.qualityByTest && result.qualityByTest.length > 0 && (
                        <div className="quality-report">
                            <h3>AI Quality Ratings</h3>
                            <div className="quality-table-wrap">
                                <table className="quality-table">
                                    <thead>
                                        <tr>
                                            <th>Test Name</th>
                                            <th>Status</th>
                                            <th>Score</th>
                                            <th>Reason</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {result.qualityByTest.map((item: QualityItem, i: number) => (
                                            <tr key={`${item.testName}-${i}`}>
                                                <td>{item.testName}</td>
                                                <td className={`status-${item.status}`}>{item.status}</td>
                                                <td>{item.qualityScore}</td>
                                                <td>{item.qualityReason}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {result.reportMarkdown && (
                        <div className="report-preview">
                            <h3>Report Preview</h3>
                            <div className="report-actions">
                                <button
                                    type="button"
                                    className="download-btn"
                                    onClick={handleDownloadMarkdown}
                                >
                                    Download Markdown
                                </button>
                                <button
                                    type="button"
                                    className="download-btn"
                                    onClick={handleDownloadJson}
                                    disabled={!result.reportJson}
                                >
                                    Download JSON
                                </button>
                            </div>
                            <pre>{result.reportMarkdown}</pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
