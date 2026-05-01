import { cn } from "@/lib/utils";

interface PortalPageHeaderProps {
  /** Short portal label shown above the title */
  eyebrow?: string;
  title: string;
  description: string;
  className?: string;
}

export function PortalPageHeader({ eyebrow, title, description, className }: PortalPageHeaderProps) {
  return (
    <header className={cn("border-b border-slate-200 pb-6", className)}>
      {eyebrow ? (
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{eyebrow}</p>
      ) : null}
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">{description}</p>
    </header>
  );
}
