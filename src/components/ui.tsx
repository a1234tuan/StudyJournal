import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

type SurfaceCardProps = HTMLAttributes<HTMLElement> & {
  as?: "article" | "section" | "div";
  variant?: "plain" | "raised" | "interactive" | "selected";
};

export const SurfaceCard = ({
  as: Component = "article",
  variant = "plain",
  className = "",
  ...props
}: SurfaceCardProps) => (
  <Component className={`surface-card surface-card-${variant} ${className}`.trim()} {...props} />
);

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
};

export const ActionButton = ({
  variant = "secondary",
  className = "",
  type = "button",
  ...props
}: ActionButtonProps) => (
  <button type={type} className={`action-button action-button-${variant} ${className}`.trim()} {...props} />
);

type PageHeaderProps = {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  density?: "normal" | "compact";
  className?: string;
};

export const PageHeader = ({
  eyebrow,
  title,
  subtitle,
  actions,
  density = "normal",
  className = "",
}: PageHeaderProps) => (
  <header className={`page-header page-header-${density} ${className}`.trim()}>
    <div>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {subtitle && <p className="page-header-subtitle">{subtitle}</p>}
    </div>
    {actions && <div className="page-header-actions">{actions}</div>}
  </header>
);

type ListRowProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
};

export const ListRow = ({ icon, title, description, meta, trailing, className = "", type = "button", ...props }: ListRowProps) => (
  <button type={type} className={`list-row ${className}`.trim()} {...props}>
    {icon && <span className="list-row-icon">{icon}</span>}
    <span className="list-row-content">
      <strong>{title}</strong>
      {description && <small>{description}</small>}
    </span>
    {(meta || trailing) && (
      <span className="list-row-end">
        {meta && <span className="list-row-meta">{meta}</span>}
        {trailing && <span className="list-row-trailing" aria-hidden="true">{trailing}</span>}
      </span>
    )}
  </button>
);
