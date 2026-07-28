// Compact two-row Pi footer. Activity integrations live in pi-sidebar.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FooterController } from "./controller.ts";

export default function footer(pi: ExtensionAPI): void {
	new FooterController(pi).register();
}
