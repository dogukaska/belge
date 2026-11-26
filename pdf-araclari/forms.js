import { download, element } from "/gunluk/common.js?v=1";
import { unicodeFont } from "./pdf.js";

const $ = id => document.getElementById(id);
const lib = () => window.PDFLib;
const types = { text: "Metin", check: "Onay kutusu", radio: "Radyo düğmesi", list: "Liste" };

function labeled(title, node) {
  const label = element("label", title);
  label.append(node);
  return label;
}

function choices(items, selected) {
  const select = element("select");
  for (const entry of items) select.append(element("option", entry, { value: entry }));
  select.value = selected ?? "";
  return select;
}

export function addFormField() {
  const group = element("fieldset", undefined, { class: "new-field" });
  group.append(element("legend", "Yeni alan"));
  const type = element("select", undefined, { "data-field-type": "" });
  for (const [key, value] of Object.entries(types)) type.append(element("option", value, { value: key }));
  const name = element("input", undefined, { maxlength: "60", placeholder: "Örn. Ad soyad", required: "", "data-field-name": "" });
  const options = element("textarea", undefined, { rows: "2", maxlength: "750", placeholder: "Her satıra bir seçenek", "data-field-options": "" });
  const choicesLabel = labeled("Seçenekler", options);
  choicesLabel.hidden = true;
  type.addEventListener("change", () => {
    options.required = type.value === "radio" || type.value === "list";
    choicesLabel.hidden = !options.required;
  });
  const remove = element("button", "Alanı kaldır", { type: "button" });
  remove.addEventListener("click", () => group.remove());
  group.append(labeled("Tür", type), labeled("Etiket", name), choicesLabel, remove);
  $("new-fields").append(group);
  name.focus();
}

export function bindExisting(doc) {
  const region = $("existing-fields");
  region.replaceChildren();
  if (!doc) return [];
  const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = lib();
  const form = doc.getForm();
  const bindings = [];
  for (const field of form.getFields()) {
    let input, apply;
    const name = field.getName();
    if (field instanceof PDFTextField) {
      input = element(field.isMultiline() ? "textarea" : "input");
      input.value = field.getText() ?? "";
      if (field.getMaxLength()) input.maxLength = field.getMaxLength();
      apply = target => target.setText(input.value);
    } else if (field instanceof PDFCheckBox) {
      input = element("input", undefined, { type: "checkbox" });
      input.checked = field.isChecked();
      apply = target => input.checked ? target.check() : target.uncheck();
    } else if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) {
      const original = field.getSelected();
      input = choices(["", ...field.getOptions()], Array.isArray(original) ? original[0] : original);
      if (field instanceof PDFOptionList || field instanceof PDFDropdown) {
        input.multiple = field.isMultiselect();
        if (input.multiple) for (const option of input.options) option.selected = original.includes(option.value);
      }
      apply = target => {
        const values = [...input.selectedOptions].map(option => option.value).filter(Boolean);
        if (values.length) target.select(input.multiple ? values : values[0]);
        else target.clear();
      };
    }
    if (!input) continue;
    input.disabled = field.isReadOnly();
    let dirty = false;
    input.addEventListener("input", () => { dirty = true; });
    input.addEventListener("change", () => { dirty = true; });
    region.append(labeled(name.startsWith("dc_") ? name.slice(3) : name, input));
    bindings.push({ name, applyTo: (newForm) => {
      if (!dirty || input.disabled) return false;
      apply(newForm.getField(name));
      return true;
    }, touched: () => dirty && !input.disabled });
  }
  if (!region.children.length) region.append(element("p", "Bu PDF’de doldurulabilir alan bulunamadı.", { class: "muted" }));
  return bindings;
}

export function newFormFields() {
  return [...$("new-fields").children].map(group => {
    const type = group.querySelector("[data-field-type]").value;
    const name = group.querySelector("[data-field-name]").value.trim();
    if (!name) throw new Error("Her form alanı için bir etiket yaz.");
    const values = [...new Set(group.querySelector("[data-field-options]").value.split("\n").map(v => v.trim()).filter(Boolean))];
    if ((type === "radio" || type === "list") && (values.length < 2 || values.length > 20)) {
      throw new Error(name + " için 2 ile 20 arası seçenek gir.");
    }
    return { type, name, values };
  });
}

export async function writeForm({ bytes, doc, base, job, bindings }) {
  const { degrees, PDFDocument, rgb } = lib();
  const drafts = newFormFields();
  if (!drafts.length && !bindings.length) throw new Error("Doldurulabilir bir PDF seç veya bir alan ekle.");
  if (!doc) doc = await PDFDocument.create();
  if (drafts.length || bindings.some(b => b.touched())) {
    const font = await unicodeFont(doc, false);
    const form = doc.getForm();
    for (const binding of bindings) binding.applyTo(form);
    const fontChars = new Set(font.getCharacterSet());
    const validText = value => [...value].every(ch => fontChars.has(ch.codePointAt(0)));
    const black = rgb(.15, .15, .16);
    let page, y = 0;
    const startPage = () => {
      page = doc.addPage([595.28, 841.89]);
      y = 782;
      page.drawText("Form", { x: 42, y: y + 7, size: 20, font, color: black });
      y -= 30;
    };
    const names = new Set(form.getFields().map(field => field.getName()));
    for (const [index, field] of drafts.entries()) {
      if (![field.name, ...field.values].every(validText)) throw new Error("Alanlarda Türkçe ve Latin yazı tipinin desteklediği karakterleri kullan.");
      const height = field.type === "radio" ? 37 + 24 * field.values.length : 67;
      if (y < height + 36) startPage();
      let key = "dc_" + field.name.replaceAll(".", " ");
      if (names.has(key)) key += "_" + (index + 1);
      while (names.has(key)) key += "_";
      names.add(key);
      page.drawText(field.name, { x: 42, y, size: Math.min(13, 500 / Math.max(1, font.widthOfTextAtSize(field.name, 1))), font, color: black });
      const placement = { x: 42, y: y - 33, width: 380, height: 23, rotate: degrees(0), textColor: black };
      if (field.type === "text") form.createTextField(key).addToPage(page, { ...placement, font });
      if (field.type === "check") form.createCheckBox(key).addToPage(page, { ...placement, width: 17, height: 17 });
      if (field.type === "list") {
        const menu = form.createDropdown(key);
        menu.addOptions(field.values);
        menu.addToPage(page, { ...placement, font });
      }
      if (field.type === "radio") {
        const group = form.createRadioGroup(key);
        for (const [i, option] of field.values.entries()) {
          const bottom = y - 29 - 24 * i;
          group.addOptionToPage(option, page, { ...placement, y: bottom, width: 15, height: 15 });
          page.drawText(option, { x: 64, y: bottom + 2, size: Math.min(12, 485 / Math.max(1, font.widthOfTextAtSize(option, 1))), font, color: black });
        }
      }
      y -= height;
    }
    form.updateFieldAppearances(font);
  }
  job.signal.throwIfAborted();
  const data = await doc.save({ updateFieldAppearances: false });
  job.signal.throwIfAborted();
  download(new Blob([data], { type: "application/pdf" }), (bytes ? base : "yeni") + "-form.pdf");
  return "Etkileşimli PDF formu indirilmeye hazır.";
}
