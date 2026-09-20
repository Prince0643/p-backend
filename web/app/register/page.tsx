"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { useAffiliateAuth } from "@/lib/useAffiliateAuth";

const PH_BANKS = [
  { value: "BDO", label: "Banco de Oro (BDO)" },
  { value: "BPI", label: "Bank of the Philippine Islands (BPI)" },
  { value: "METROBANK", label: "Metrobank" },
  { value: "LANDBANK", label: "Land Bank of the Philippines" },
  { value: "PNB", label: "Philippine National Bank (PNB)" },
  { value: "UNIONBANK", label: "UnionBank" },
  { value: "SECURITY_BANK", label: "Security Bank" },
  { value: "RCBC", label: "RCBC" },
  { value: "OTHER", label: "Other Bank" },
];

function normalizePhPhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (/^09\d{9}$/.test(digits)) return `+63${digits.slice(1)}`;
  if (/^9\d{9}$/.test(digits)) return `+63${digits}`;
  if (/^63\d{10}$/.test(digits)) return `+${digits}`;
  return raw;
}

export default function RegisterPage() {
  const router = useRouter();
  const { setSession } = useAffiliateAuth();
  const formRef = useRef<HTMLFormElement>(null);
  const [region, setRegion] = useState<"PH" | "GLOBAL" | "">("");
  const [phMethod, setPhMethod] = useState("");
  const [globalMethod, setGlobalMethod] = useState("");
  const [termsOpen, setTermsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ couponCode: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const isEwallet = phMethod === "GCASH" || phMethod === "MAYA";
  const isBank = region === "PH" && phMethod && !isEwallet;
  const isOtherBank = phMethod === "OTHER";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const fd = new FormData(form);
    const data = Object.fromEntries(fd.entries()) as Record<string, string>;
    data.preferredBank = region === "PH" ? phMethod : globalMethod;
    data.termsAccepted = String((fd.get("termsAccepted") as string) === "on");
    data.termsVersion = "2026-09-17";

    setSubmitting(true);
    try {
      const res = await apiFetch<{ couponCode: string; affiliateId: string; token: string }>(
        "/api/affiliates/register",
        "",
        { method: "POST", body: data }
      );
      setSession({ token: res.token, affiliateId: res.affiliateId, email: data.email });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "We could not complete your registration. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyCoupon() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.couponCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable - code is already visible on-screen.
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <header className="mb-7 text-center">
        <div className="mb-2.5 text-xs font-extrabold uppercase tracking-[0.14em] text-blue-400">
          Nexistry Digital Solutions
        </div>
        <h1 className="mb-3 bg-gradient-to-br from-white to-blue-200 bg-clip-text text-4xl font-bold text-transparent">
          Become an Affiliate
        </h1>
        <p className="mx-auto max-w-lg text-[15px] leading-relaxed text-slate-400">
          Share Nexistry with your network. Your customers get 15% off, you earn 10% commission on every sale — paid
          out weekly.
        </p>
      </header>

      {result ? (
        <div className="rounded-[18px] border border-white/10 bg-gradient-to-b from-white/[.045] to-white/[.02] p-7 text-center shadow-2xl">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border-2 border-emerald-400 bg-emerald-400/15 text-2xl font-extrabold text-emerald-400">
            ✓
          </div>
          <h2 className="mb-2.5 text-xl font-bold">You&apos;re registered!</h2>
          <p className="mx-auto mb-4.5 max-w-md text-sm leading-relaxed text-slate-400">
            Share this code with your customers — it gives them 15% off and earns you 10% commission. It works once,
            for one customer.
          </p>
          <div className="mb-4.5 inline-flex items-center gap-3 rounded-xl border border-dashed border-blue-400 bg-blue-400/10 px-4.5 py-3.5">
            <span className="font-mono text-xl font-extrabold tracking-wider">{result.couponCode}</span>
            <button
              onClick={copyCoupon}
              className="rounded-lg border border-white/10 bg-white/10 px-3.5 py-2 text-xs font-bold"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => router.push("/affiliate/dashboard")}
            className="mb-4.5 flex min-h-[48px] w-full items-center justify-center rounded-xl bg-gradient-to-br from-blue-400 to-purple-500 text-[15px] font-extrabold text-slate-950"
          >
            Go to My Dashboard
          </button>
          <p className="text-xs text-slate-400">
            Payouts are processed weekly on Saturdays. Questions? Contact{" "}
            <a href="mailto:billing@nexistrydigitalsolutions.com" className="text-blue-400">
              billing@nexistrydigitalsolutions.com
            </a>
            .
          </p>
        </div>
      ) : (
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="rounded-[18px] border border-white/10 bg-gradient-to-b from-white/[.045] to-white/[.02] p-7 shadow-2xl"
        >
          {error && (
            <div className="mb-4.5 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">
              {error}
            </div>
          )}

          <Section title="Personal Information">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="First Name" required>
                <input name="firstName" required className="input" autoComplete="given-name" />
              </Field>
              <Field label="Last Name" required>
                <input name="lastName" required className="input" autoComplete="family-name" />
              </Field>
              <Field label="Email Address" required>
                <input name="email" type="email" required className="input" autoComplete="email" />
              </Field>
              <Field label="Password" required hint="At least 8 characters. This logs you into your affiliate dashboard.">
                <input
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  className="input"
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Contact Number" required hint="Include your country code, e.g. +63 for the Philippines.">
                <input
                  name="contactNumber"
                  type="tel"
                  required
                  className="input"
                  placeholder="+63 9XX XXX XXXX"
                  onBlur={(e) => {
                    if (region === "PH") e.currentTarget.value = normalizePhPhone(e.currentTarget.value);
                  }}
                />
              </Field>
            </div>
          </Section>

          <Section title="Social Media" optional>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Facebook"><input name="facebook" className="input" placeholder="Profile URL or username" /></Field>
              <Field label="Instagram"><input name="instagram" className="input" placeholder="Profile URL or @username" /></Field>
              <Field label="TikTok"><input name="tiktok" className="input" placeholder="Profile URL or @username" /></Field>
              <Field label="YouTube"><input name="youtube" className="input" placeholder="Channel URL or name" /></Field>
            </div>
          </Section>

          <Section title="Payout Details">
            <fieldset className="mb-4.5">
              <legend className="mb-2 text-xs font-semibold text-slate-300">
                Payment Region <span className="text-red-400">*</span>
              </legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(["PH", "GLOBAL"] as const).map((r) => (
                  <label
                    key={r}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3.5 ${
                      region === r ? "border-blue-400 bg-blue-400/10" : "border-white/10 bg-[#0a1224_80]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="paymentRegion"
                      value={r}
                      required
                      checked={region === r}
                      onChange={() => {
                        setRegion(r);
                        setPhMethod("");
                        setGlobalMethod("");
                      }}
                    />
                    <span>
                      <strong>{r === "PH" ? "Philippines" : "Global"}</strong>
                      <br />
                      <span className="text-xs text-slate-400">{r === "PH" ? "GCash, Maya, or local bank" : "Wise or PayPal"}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {region === "PH" && (
              <div className="border-t border-dashed border-white/10 pt-4">
                <Field label="Payment Method" required>
                  <select className="input" required value={phMethod} onChange={(e) => setPhMethod(e.target.value)}>
                    <option value="">Select a payment method</option>
                    <option value="GCASH">GCash</option>
                    <option value="MAYA">Maya</option>
                    {PH_BANKS.map((b) => (
                      <option key={b.value} value={b.value}>{b.label}</option>
                    ))}
                  </select>
                </Field>

                {isEwallet && (
                  <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Account-holder Name" required>
                      <input name="ewalletName" required className="input" />
                    </Field>
                    <Field label="Registered Mobile Number" required>
                      <input name="ewalletNumber" required className="input" />
                    </Field>
                  </div>
                )}

                {isBank && (
                  <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {isOtherBank && (
                      <div className="sm:col-span-2">
                        <Field label="Bank Name" required>
                          <input name="otherBankName" required className="input" />
                        </Field>
                      </div>
                    )}
                    <Field label="Account Name" required>
                      <input name="bankAccountName" required className="input" />
                    </Field>
                    <Field label="Account Number" required>
                      <input name="bankAccountNumber" required className="input" inputMode="numeric" />
                    </Field>
                    <Field label="Bank Branch" required>
                      <input name="bankBranch" required className="input" />
                    </Field>
                  </div>
                )}
              </div>
            )}

            {region === "GLOBAL" && (
              <div className="border-t border-dashed border-white/10 pt-4">
                <Field label="Payment Method" required>
                  <select className="input" required value={globalMethod} onChange={(e) => setGlobalMethod(e.target.value)}>
                    <option value="">Select a payment method</option>
                    <option value="WISE">Wise</option>
                    <option value="PAYPAL">PayPal</option>
                  </select>
                </Field>
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Account-holder Name" required>
                    <input name="globalAccountName" required className="input" />
                  </Field>
                  <Field label="Account Email" required>
                    <input name="globalAccountEmail" type="email" required className="input" />
                  </Field>
                </div>
              </div>
            )}
          </Section>

          <label className="mb-5.5 flex items-start gap-3 rounded-xl border border-white/10 bg-[#0a122480] p-4 text-[13px] leading-relaxed">
            <input type="checkbox" name="termsAccepted" required className="mt-0.5" />
            <span>
              I agree to the{" "}
              <button type="button" onClick={() => setTermsOpen(true)} className="text-blue-400 underline">
                Terms and Conditions
              </button>
              , including the 15% customer discount / 10% commission structure and weekly Saturday payouts.{" "}
              <span className="text-red-400">*</span>
            </span>
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="flex min-h-[52px] w-full items-center justify-center gap-2.5 rounded-xl bg-gradient-to-br from-blue-400 to-purple-500 text-[15px] font-extrabold text-slate-950 disabled:opacity-60"
          >
            {submitting ? "Registering…" : "Complete Registration"}
          </button>
        </form>
      )}

      <footer className="mt-6 text-center text-xs leading-loose text-slate-400">
        <p>
          Questions?{" "}
          <a href="mailto:support.creators@nexistrydigitalsolutions.com" className="text-blue-400">
            support.creators@nexistrydigitalsolutions.com
          </a>
        </p>
        <p>© {new Date().getFullYear()} Nexistry Digital Solutions</p>
      </footer>

      {termsOpen && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/75 p-4"
          onClick={(e) => e.target === e.currentTarget && setTermsOpen(false)}
        >
          <div className="max-h-[85vh] w-full max-w-xl overflow-hidden rounded-2xl bg-[#0f1b33] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 p-5">
              <h2 className="text-lg font-bold">Terms and Conditions</h2>
              <button
                onClick={() => setTermsOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-lg"
              >
                ×
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-5 text-sm leading-relaxed text-slate-400">
              <h3 className="mb-1.5 mt-0 text-white">1. Commission Structure</h3>
              <p>
                Affiliates receive a 10% commission on qualifying purchases. Customers who use your assigned discount
                code receive a 15% discount. Your code is one-time-use, tied to your account.
              </p>
              <h3 className="mb-1.5 mt-4.5 text-white">2. Payment Policy</h3>
              <p>
                Payouts are processed weekly, on Saturdays, through your selected payment method. Global payouts may
                vary in timing and fees by provider.
              </p>
              <h3 className="mb-1.5 mt-4.5 text-white">3. Accuracy of Payment Information</h3>
              <p>
                You are responsible for providing accurate payout details. Nexistry Digital Solutions is not
                responsible for delays or rejected transfers due to incorrect account information.
              </p>
              <h3 className="mb-1.5 mt-4.5 text-white">4. Code of Conduct</h3>
              <p>Affiliates must act professionally and follow applicable laws. Fraudulent referrals or misuse of tracking may result in termination.</p>
              <h3 className="mb-1.5 mt-4.5 text-white">5. No Registration Fees</h3>
              <p>No upfront fee is required to join. Commissions are earned only from legitimate qualifying purchases.</p>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Section({ title, optional, children }: { title: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <section className="mb-7 last:mb-0">
      <h2 className="mb-4 border-b border-white/10 pb-2.5 text-[13px] uppercase tracking-wide text-slate-400">
        {title} {optional && <span className="normal-case text-slate-500">(optional)</span>}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-semibold text-slate-200">
        {label} {required && <span className="text-red-400">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}
