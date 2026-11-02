<script module lang="ts">
const BASE =
	"rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-60";
const VARIANTS = {
	outline:
		"border border-line bg-white text-ink-soft hover:border-brand hover:text-brand",
	primary: "bg-brand text-white shadow-sm hover:brightness-95",
};
const SIZES = {
	sm: "px-3 py-1.5 text-xs",
	md: "px-4 py-2 text-sm",
	lg: "px-6 py-2.5 text-sm",
};

// The classes of a Button, for elements that can't be one, such as a dialog's cancel button.
export const buttonClass = (
	variant: keyof typeof VARIANTS = "outline",
	size: keyof typeof SIZES = "md",
): string => `${BASE} ${VARIANTS[variant]} ${SIZES[size]}`;
</script>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

type Props = HTMLButtonAttributes & {
	variant?: keyof typeof VARIANTS;
	size?: keyof typeof SIZES;
};

let {
	variant = "outline",
	size = "md",
	type = "button",
	class: className = "",
	children,
	...rest
}: Props = $props();
</script>

<button {type} class="{buttonClass(variant, size)} {className}" {...rest}>
	{@render children?.()}
</button>
