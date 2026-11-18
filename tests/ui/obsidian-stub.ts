// Small DOM adapter for settings callbacks; native host behavior is covered by E2E.
export class ItemView {
	contentEl = document.createElement("div");
	constructor(public leaf: unknown) {}
}
export class PluginSettingTab {
	constructor(
		public app: unknown,
		public plugin: unknown,
	) {}
	hide() {}
}
export class FileSystemAdapter {}
export class Modal {}
export class Menu {}
export class ButtonComponent {}
export class DropdownComponent {}
export const setIcon = () => {};
export const normalizePath = (path: string) => path;
export class TextComponent {
	inputEl = document.createElement("input");
	constructor(parent: HTMLElement) {
		parent.append(this.inputEl);
	}
	setValue(value: string) {
		this.inputEl.value = value;
		return this;
	}
	setPlaceholder(value: string) {
		this.inputEl.placeholder = value;
		return this;
	}
	onChange(fn: (value: string) => unknown) {
		this.inputEl.addEventListener("input", () => {
			fn(this.inputEl.value);
		});
		return this;
	}
}
export class ToggleComponent {
	toggleEl = document.createElement("input");
	private value = false;
	private callback?: (value: boolean) => unknown;
	constructor(parent: HTMLElement) {
		this.toggleEl.type = "checkbox";
		parent.append(this.toggleEl);
		this.toggleEl.addEventListener("change", () =>
			this.setValue(this.toggleEl.checked),
		);
	}
	setValue(value: boolean) {
		this.toggleEl.checked = value;
		if (this.value !== value) {
			this.value = value;
			this.callback?.(value);
		}
		return this;
	}
	setDisabled(value: boolean) {
		this.toggleEl.disabled = value;
		return this;
	}
	onChange(fn: (value: boolean) => unknown) {
		this.callback = fn;
		return this;
	}
}
export class Setting {
	controlEl = document.createElement("div");
	description = "";
	setName(_name: string) {
		return this;
	}
	setDesc(value: string) {
		this.description = value;
		return this;
	}
	addText(fn: (t: TextComponent) => unknown) {
		fn(new TextComponent(this.controlEl));
		return this;
	}
	addToggle(fn: (t: ToggleComponent) => unknown) {
		fn(new ToggleComponent(this.controlEl));
		return this;
	}
}
