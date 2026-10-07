"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { TestCards } from "@/components/TestCards";

const DEFAULT_BACKEND = "https://api.nexistrydigitalsolutions.com";
const DEFAULT_ACCENT = "#2563eb";
const DEFAULT_BUTTON = "Pay now";
const DEFAULT_RADIUS = 10;

function escapeAttr(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildEmbed(opts: {
  productId: string;
  backendUrl: string;
  accent: string;
  buttonText: string;
  radius: number;
  apiBase?: string;
}) {
  const attrs = [`data-nx-product="${escapeAttr(opts.productId)}"`];
  if (opts.accent.toLowerCase() !== DEFAULT_ACCENT) attrs.push(`data-accent="${escapeAttr(opts.accent)}"`);
  if (opts.buttonText !== DEFAULT_BUTTON) attrs.push(`data-button-text="${escapeAttr(opts.buttonText)}"`);
  if (opts.radius !== DEFAULT_RADIUS) attrs.push(`data-radius="${opts.radius}"`);
  if (opts.apiBase) attrs.push(`data-api-base="${escapeAttr(opts.apiBase)}"`);
  const base = opts.backendUrl.trim().replace(/\/+$/, "");
  return `<div ${attrs.join(" ")}></div>\n<script src="${escapeAttr(base)}/public/nx-embed.js" async></script>`;
}

const subscribeNoop = () => () => {};
const getOrigin = () => window.location.origin;
const getServerOrigin = () => "";

export function EmbedPanel({
  productId,
  onCopyFallbackToast,
  onTestCheckout,
  version = 0,
}: {
  productId: string;
  onCopyFallbackToast: (m: string) => void;
  onTestCheckout: (productId: string) => void;
  version?: number;
}) {
  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND);
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [buttonText, setButtonText] = useState(DEFAULT_BUTTON);
  const [radius, setRadius] = useState(DEFAULT_RADIUS);
  const [copied, setCopied] = useState(false);
  const origin = useSyncExternalStore(subscribeNoop, getOrigin, getServerOrigin);
  const [height, setHeight] = useState(720);
  const observerRef = useRef<ResizeObserver | null>(null);

  const embed = buildEmbed({ productId, backendUrl, accent, buttonText, radius });

  // Preview points at this origin so it works on localhost and prod alike.
  const previewMarkup = origin
    ? buildEmbed({ productId, backendUrl: origin, accent, buttonText, radius, apiBase: origin })
    : "";
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:16px;font-family:system-ui,sans-serif;background:#fff}</style></head><body>${previewMarkup}</body></html>`;
  const previewKey = `${productId}|${accent}|${buttonText}|${radius}|${origin}|${version}`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(embed);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = embed;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
      if (!ok) {
        onCopyFallbackToast("Could not copy - select and copy manually.");
        return;
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleIframeLoad(e: React.SyntheticEvent<HTMLIFrameElement>) {
    observerRef.current?.disconnect();
    const doc = e.currentTarget.contentDocument;
    if (!doc || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setHeight(Math.max(720, doc.documentElement.scrollHeight));
    });
    ro.observe(doc.body);
    observerRef.current = ro;
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 p-3.5">
        <h2 className="text-xs font-bold uppercase tracking-wide text-slate-200">Embed form</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onTestCheckout(productId)}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm font-bold text-amber-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          >
            Test checkout
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
      <div className="px-4 pb-4">
        <p className="mb-3 text-xs text-slate-400">
          Paste into a GHL Custom Code element. The form always uses this product&apos;s current price.
        </p>
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-semibold text-slate-300">Backend URL</span>
            <input className="input" value={backendUrl} onChange={(e) => setBackendUrl(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-300">Accent color</span>
            <input
              type="color"
              className="h-10 w-full cursor-pointer rounded-lg border border-white/10 bg-[#0c162ce6] p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-300">Button text</span>
            <input className="input" value={buttonText} onChange={(e) => setButtonText(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-slate-300">Corner radius (px)</span>
            <input
              className="input"
              type="number"
              min={0}
              max={40}
              value={radius}
              onChange={(e) => setRadius(Math.max(0, Math.min(40, Number(e.target.value) || 0)))}
            />
          </label>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-slate-300">Embed code</span>
          <textarea
            readOnly
            value={embed}
            className="h-28 w-full resize-y rounded-lg border border-white/10 bg-[#0c162ce6] p-3 font-mono text-xs leading-relaxed"
          />
        </label>

        <div className="mt-4">
          <TestCards />
        </div>

        <h3 className="mb-1.5 mt-4 text-xs font-bold uppercase tracking-wide text-slate-200">Live preview</h3>
        <p className="mb-2 text-[11px] text-amber-300">
          Warning: submitting the preview creates a real PayMongo checkout. Use <b>Test checkout</b> above to try it
          with PayMongo test cards instead.
        </p>
        {origin && (
          <iframe
            key={previewKey}
            title="Embed form live preview"
            srcDoc={srcDoc}
            onLoad={handleIframeLoad}
            style={{ height }}
            className="w-full rounded-lg border border-white/10 bg-white"
          />
        )}
      </div>
    </>
  );
}
