import type { Metadata } from "next";

export const metadata: Metadata = { title: "Products - Nexistry Backend" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
