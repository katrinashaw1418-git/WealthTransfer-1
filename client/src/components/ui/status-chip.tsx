import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Global status design system (advice-only portals).
 * Domains: Advice, Fee consent, Report/document, Goal, Client & fact-find, Workflow.
 */
const statusChipVariants = cva(
  "inline-flex max-w-full items-center rounded-md border px-2 py-0.5 text-xs font-medium leading-tight",
  {
    variants: {
      domain: {
        advice: "border-sky-200 bg-sky-50 text-sky-950",
        feeConsent: "border-amber-200 bg-amber-50 text-amber-950",
        report: "border-slate-200 bg-slate-50 text-slate-900",
        goal: "border-violet-200 bg-violet-50 text-violet-950",
        clientFactFind: "border-emerald-200 bg-emerald-50 text-emerald-950",
        workflow: "border-slate-300 bg-white text-slate-800",
      },
      emphasis: {
        default: "",
        solid: "",
      },
    },
    compoundVariants: [
      {
        domain: "advice",
        emphasis: "solid",
        class: "border-transparent bg-sky-600 text-white",
      },
      {
        domain: "feeConsent",
        emphasis: "solid",
        class: "border-transparent bg-amber-600 text-white",
      },
      {
        domain: "report",
        emphasis: "solid",
        class: "border-transparent bg-slate-700 text-white",
      },
      {
        domain: "goal",
        emphasis: "solid",
        class: "border-transparent bg-violet-600 text-white",
      },
      {
        domain: "clientFactFind",
        emphasis: "solid",
        class: "border-transparent bg-emerald-600 text-white",
      },
      {
        domain: "workflow",
        emphasis: "solid",
        class: "border-transparent bg-slate-800 text-white",
      },
    ],
    defaultVariants: {
      domain: "workflow",
      emphasis: "default",
    },
  },
);

export type StatusChipDomain = NonNullable<VariantProps<typeof statusChipVariants>["domain"]>;

export interface StatusChipProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusChipVariants> {
  children: React.ReactNode;
}

export function StatusChip({ className, domain, emphasis, children, ...props }: StatusChipProps) {
  return (
    <span
      className={cn(statusChipVariants({ domain, emphasis }), className)}
      data-status-domain={domain ?? "workflow"}
      {...props}
    >
      {children}
    </span>
  );
}
