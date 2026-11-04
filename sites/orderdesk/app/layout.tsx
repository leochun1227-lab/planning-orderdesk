import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orderdesk · Regent RV",
  description: "Regent RV 订单工作台",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
