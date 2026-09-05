import { registry } from "virtual:icons";
import type { JSX } from "solid-js";

export interface IconData {
  body: string;
  height: number;
  width: number;
}

export interface IconProps extends JSX.SvgSVGAttributes<SVGSVGElement> {
  icon: string | IconData;
  size?: number;
  class?: string;
}

/**
 * Universal Icon component backed by @zomme/bun-plugin-iconify.
 * Renders SVG icons from virtual:icons with zero runtime overhead.
 */
export function Icon(props: IconProps) {
  const iconData = () =>
    typeof props.icon === "string" ? registry[props.icon] : props.icon;

  return (
    /* eslint-disable solid/no-innerhtml -- icon bodies come from the build-time icon registry, never user input */
    <svg
      innerHTML={iconData()?.body || ""}
      height={props.size ? `${props.size}px` : "1em"}
      width={props.size ? `${props.size}px` : "1em"}
      viewBox={`0 0 ${iconData()?.width ?? 24} ${iconData()?.height ?? 24}`}
      xmlns="http://www.w3.org/2000/svg"
      class={`inline-block shrink-0 ${props.class ?? ""}`}
      style={{
        width: props.size ? `${props.size}px` : "1em",
        height: props.size ? `${props.size}px` : "1em",
      }}
      aria-hidden="true"
    />
    /* eslint-enable solid/no-innerhtml */
  );
}

export default Icon;
