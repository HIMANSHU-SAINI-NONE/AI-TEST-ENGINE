import type { Metadata } from "next";
import "./globals.css";

// metadata for the page
export const metadata: Metadata = {
    title: "AI Test Engineer",
    description: "Upload your project and generate tests",
};

// this is the root layout that wraps everything
export default function RootLayout({ children }: any) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
