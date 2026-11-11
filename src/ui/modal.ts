import { type App, ButtonComponent, Modal, setIcon } from "obsidian";

export function renderModalHead(
	modal: Modal,
	options: { title: string; icon: string; sub?: string },
) {
	modal.titleEl.empty();
	modal.titleEl.addClass("ocs-heading");
	setIcon(modal.titleEl.createSpan({ cls: "ocs-heading-icon" }), options.icon);
	const text = modal.titleEl.createDiv();
	text.createDiv({ text: options.title });
	if (options.sub) text.createDiv({ cls: "ocs-subtitle", text: options.sub });
}

export function modalHint(parent: HTMLElement, text: string) {
	return parent.createEl("p", { cls: "ocs-hint", text });
}

export function openConfirmModal(options: {
	app: App;
	title: string;
	body: readonly string[];
	confirmLabel: string;
	cancelLabel: string;
}): Promise<boolean> {
	return new Promise((resolve) => {
		class Confirm extends Modal {
			private accepted = false;
			onOpen() {
				renderModalHead(this, { title: options.title, icon: "circle-help" });
				for (const text of options.body) this.contentEl.createEl("p", { text });
				const buttons = this.contentEl.createDiv({
					cls: "modal-button-container",
				});
				const cancel = new ButtonComponent(buttons)
					.setButtonText(options.cancelLabel)
					.onClick(() => this.close());
				new ButtonComponent(buttons)
					.setButtonText(options.confirmLabel)
					.setCta()
					.onClick(() => {
						this.accepted = true;
						this.close();
					});
				cancel.buttonEl.focus();
			}
			onClose() {
				resolve(this.accepted);
			}
		}
		new Confirm(options.app).open();
	});
}
