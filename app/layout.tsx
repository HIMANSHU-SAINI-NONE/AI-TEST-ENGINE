import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "AI Test Engineer",
    description: "Upload your project and generate tests",
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
