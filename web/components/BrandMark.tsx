import Image from "next/image";

const LOGO_SRC = "/images/nexistry-core-logo.jpg";

export function BrandMark({
  size = "md",
  showText = true,
  subtitle,
}: {
  size?: "sm" | "md" | "lg";
  showText?: boolean;
  subtitle?: string;
}) {
  const logoSize = size === "lg" ? "h-16 w-16" : size === "sm" ? "h-9 w-9" : "h-12 w-12";
  const titleSize = size === "lg" ? "text-xl" : "text-sm";

  return (
    <div className="flex items-center gap-3">
      <div className={`${logoSize} overflow-hidden rounded-xl border border-cyan-300/25 bg-white p-1 shadow-[0_0_30px_rgba(14,165,233,.18)]`}>
        <Image src={LOGO_SRC} alt="Nexistry Core" width={96} height={96} className="h-full w-full object-contain" priority={size === "lg"} />
      </div>
      {showText && (
        <div>
          <div className={`${titleSize} font-extrabold tracking-wide text-white`}>Nexistry Core</div>
          {subtitle && <div className="text-xs text-slate-400">{subtitle}</div>}
        </div>
      )}
    </div>
  );
}
