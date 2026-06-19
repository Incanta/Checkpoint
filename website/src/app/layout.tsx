import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Checkpoint • Version Control for Creative Workflows",
  description:
    "Checkpoint is a modern version control system built for media workflows • games, film, product design, architecture, and more. Built by Incanta.",
  metadataBase: new URL("https://checkpointvcs.com"),
  openGraph: {
    title: "Checkpoint • Version Control for Creative Workflows",
    description:
      "A modern version control system built for media workflows • games, film, product design, architecture, and more.",
    url: "https://checkpointvcs.com",
    siteName: "Checkpoint VCS",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Checkpoint VCS",
    description:
      "Modern version control for media workflows • games, film, product design, architecture, and more.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
