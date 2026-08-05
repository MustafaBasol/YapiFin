import { DynamicIcon } from "lucide-react/dynamic";
import type { ComponentProps } from "react";

type DynamicIconProps = ComponentProps<typeof DynamicIcon>;

/**
 * Renders any lucide icon by its kebab-case name (e.g. "layout-dashboard").
 * Lets app.config.ts reference icons as plain strings.
 */
export function Icon({
  name,
  ...props
}: { name: string } & Omit<DynamicIconProps, "name">) {
  return <DynamicIcon name={name as DynamicIconProps["name"]} {...props} />;
}
