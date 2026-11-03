// Runs inside the application page (page.evaluate). Returns every fillable control, with radio,
// checkbox and Yes/No button groups collapsed into one field each. Keys are derived from element
// ids/names so the same script finds the same fields again when the form is reopened to submit.
(() => {
  const SKIP_TYPES = ['hidden', 'submit', 'button', 'search', 'image', 'reset'];
  const raw = (el) => (el ? el.textContent || '' : '');
  // Drops required marks and question numbering ("2. First name" → "First name").
  const clean = (s) =>
    (s || '')
      .replace(/[*✱]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(q(uestion)?\s*)?\d{1,3}\s*[.)]\s*/i, '');
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

  // Field labels that say nothing about the question ("Date", "Phone number"): the question
  // card's title, when there is one, is a better label (e.g. "Date of Birth").
  const GENERIC_LABEL =
    /^(date|time|phone( number)?|mobile( number)?|number|text|answer|your answer|enter( here)?|select|choose( one)?|value|type here)$/i;
  function rawLabel(el) {
    if (el.getAttribute('type') === 'file') {
      if (
        /resume|\bcv\b/i.test(el.id + ' ' + el.getAttribute('name')) ||
        el.closest('[class*="resume-upload"]')
      )
        return 'Resume/CV';
    }
    const label = directLabel(el);
    if (GENERIC_LABEL.test(clean(label))) {
      const card = el.closest('[class*="question"], [data-automation-id="questionItem"]');
      const title = card && nearbyLabel(el, LABEL_SELECTORS.slice(1, 2), card);
      if (title) return title;
    }
    return label;
  }

  function directLabel(el) {
    const question = el.closest('[data-automation-id="questionItem"]');
    const heading = question && question.querySelector('[role="heading"]');
    if (heading) return raw(heading);
    if (el.id) {
      const l = document.querySelector('label[for="' + esc(el.id) + '"]');
      if (l && clean(raw(l))) return raw(l);
    }
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      // Material dropdowns list their own selected value here: "India" is not the question.
      const t = by
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((n) => n && !el.contains(n))
        .map(raw)
        .join(' ');
      if (clean(t)) return t;
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    // Lever: the question text lives in .application-label; the wrapping <label> also holds
    // button and helper text.
    const leverQ = el.closest('.application-question');
    const leverLabel = leverQ && leverQ.querySelector('.application-label');
    if (leverLabel && clean(raw(leverLabel))) return raw(leverLabel);
    const wrap = el.closest('label');
    if (wrap && clean(raw(wrap))) return raw(wrap);
    const near = nearbyLabel(el);
    if (near) return near;
    return el.getAttribute('placeholder') || '';
  }

  // Question text near a control, for forms that don't use <label for>: the nearest container
  // with a non-empty label or question title *before* the control (card-style surveys such as
  // Infosys, Google Forms and Typeform-like builders put the question in a title element).
  const LABEL_SELECTORS = [
    'legend, label, .application-label, .application-question .text, [class*="label"]',
    '[class*="question-text"], [class*="questionText"], [class*="display-text"], [class*="question-title"], [class*="questionTitle"], [role="heading"]',
    '[class*="title"], h2, h3, h4, h5, h6',
  ];
  const before = (a, b) =>
    Boolean(a.compareDocumentPosition(b) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  function nearbyLabel(el, selectors = LABEL_SELECTORS, stop) {
    let c = el.parentElement;
    for (let i = 0; i < 10 && c && c !== document.body; i++, c = c.parentElement) {
      for (const sel of selectors) {
        const hits = [...c.querySelectorAll(sel)].filter(
          (l) => !l.contains(el) && before(l, el) && clean(raw(l)),
        );
        if (hits.length) {
          const node = hits[hits.length - 1];
          const text = raw(node);
          // A long title block (question + help text): its first line is the question.
          const first = (node.innerText || '').split(/\n/).map(clean).find(Boolean) || '';
          return clean(text).length > 120 && first ? first : text;
        }
      }
      if (c === stop) break;
    }
    return '';
  }

  function groupLabel(el) {
    const fs = el.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg && clean(raw(lg))) return raw(lg);
    }
    const group = el.closest('[role="radiogroup"], [role="group"]');
    if (group) {
      if (group.getAttribute('aria-label')) return group.getAttribute('aria-label');
      const by = group.getAttribute('aria-labelledby');
      if (by) {
        const nodes = by
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean);
        const heading = nodes.map((n) => n.querySelector('[role="heading"]')).find(Boolean);
        if (heading) return raw(heading);
        if (nodes.length) return nodes.map(raw).join(' ');
      }
    }
    const question = el.closest('[data-automation-id="questionItem"]');
    const heading = question && question.querySelector('[role="heading"]');
    if (heading) return raw(heading);
    const q = el.closest(
      '.application-question, [class*="fieldEntry"], [class*="question"], [role="group"], [role="radiogroup"]',
    );
    if (q) {
      const l = q.querySelector('.application-label, .text, label, legend, [class*="label"]');
      if (l && clean(raw(l))) return raw(l);
    }
    return rawLabel(el);
  }

  // The heading of the section holding a question, when one section repeats questions of
  // another ("Board" under "X/SSLC" and under "XII Standard"). A section's heading is the first
  // title in a container of several questions, in a block without controls of its own.
  const SECTION_TITLES =
    'legend, h1, h2, h3, h4, h5, h6, [role="heading"], [class*="display-text"], [class*="section-title"], [class*="sectionTitle"], [class*="section-header"], [class*="sectionHeader"], [class*="question-title"], [class*="questionTitle"]';
  const CONTROLS =
    'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radio"], [role="checkbox"], [role="option"], [role="listbox"], .input-container';
  function sectionOf(el, ownLabel) {
    const own = clean(ownLabel).toLowerCase();
    for (let c = el.parentElement, i = 0; c && c !== document.body && i < 30; c = c.parentElement, i++) {
      const title = [...c.querySelectorAll(SECTION_TITLES)].find(
        (t) => !t.contains(el) && clean(raw(t)) && visible(t),
      );
      if (!title || !before(title, el)) continue;
      const text = clean(raw(title));
      if (text.toLowerCase() === own || text.length > 120) continue;
      let block = title;
      while (block.parentElement && block.parentElement !== c) block = block.parentElement;
      if (block.contains(el) || block.querySelector(CONTROLS)) continue;
      return text;
    }
    return '';
  }

  const optionLabel = (input) => {
    const l = input.id && document.querySelector('label[for="' + esc(input.id) + '"]');
    return clean(raw(l || input.closest('label')) || input.value);
  };

  const required = (el, label) => {
    const question = el.closest('[data-automation-id="questionItem"]');
    return Boolean(
      el.required ||
      el.getAttribute('aria-required') === 'true' ||
      el.closest('[aria-required="true"]') ||
      /[*✱]/.test(label) ||
      (question &&
        question.querySelector('[data-automation-id="requiredStar"][aria-hidden="false"]')),
    );
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  // Only this part of the page, when set (e.g. LinkedIn's Easy Apply dialog).
  const ROOT = (window.__jaRoot && document.querySelector(window.__jaRoot)) || document;
  const fields = [];
  // Each field's element, to return the fields in page order.
  const elOf = new Map();
  const add = (list, el, f) => {
    const section = sectionOf(el, f.label);
    if (section) f.section = section;
    list.push(f);
    elOf.set(f, el);
  };
  const usedKeys = new Set();
  const seenGroups = new Set();
  const keyFor = (el, label) => {
    let k =
      el.id ||
      el.getAttribute('name') ||
      'label:' +
        clean(label)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 50);
    let n = 2;
    const base = k;
    while (usedKeys.has(k)) k = base + '#' + n++;
    usedKeys.add(k);
    return k;
  };
  const selectorFor = (el, key) => {
    // Survey builders reuse a question's id on its wrapper and its input. Mark the actual
    // control so neither duplicate ids nor repeated names can resolve to the wrapper.
    el.setAttribute('data-ja-control', key);
    return '[data-ja-control="' + key.replace(/"/g, '\\"') + '"]';
  };

  for (const el of ROOT.querySelectorAll('input, textarea, select, [role="combobox"]')) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    const name = el.getAttribute('name') || '';
    // Dropdown filters can briefly remain mounted after selection. They are widget controls,
    // not newly revealed questions, and must not keep the form-rescan loop running.
    if (el.closest('[role="listbox"], [role="option"], ngx-mat-select-search')) continue;
    if (SKIP_TYPES.includes(type)) continue;
    if (/g-recaptcha-response|h-captcha-response/.test(name + el.id)) continue;
    if (/requiredInput/i.test(el.className) || el.getAttribute('aria-hidden') === 'true') continue;
    if (type !== 'file' && !visible(el)) continue;
    if (type === 'file' && (!el.parentElement || !visible(el.parentElement))) continue;
    // Filled in by the page itself (e.g. State and District from a pincode).
    // Date pickers are often read-only text boxes that open a calendar: those are kept.
    const datePicker =
      el.tagName === 'INPUT' &&
      (/datepicker|date-picker|calendar/i.test(
        el.className + ' ' + (el.getAttribute('data-mat-calendar') ? 'calendar' : ''),
      ) ||
        (el.readOnly && el.getAttribute('aria-haspopup') === 'dialog'));
    if (type !== 'file' && el.disabled) continue;
    if (type !== 'file' && el.readOnly && !datePicker) continue;

    if ((type === 'radio' || type === 'checkbox') && name) {
      const members = [
        ...document.querySelectorAll('input[name="' + name.replace(/"/g, '\\"') + '"]'),
      ];
      if (members.length > 1) {
        if (seenGroups.has(name)) continue;
        seenGroups.add(name);
        const label = groupLabel(el);
        add(fields, el, {
          key: keyFor({ getAttribute: (a) => (a === 'name' ? name : null) }, label),
          label: clean(label),
          kind: type === 'radio' ? 'radio' : 'checkboxes',
          required: members.some((m) => required(m, label)),
          options: members.map(optionLabel),
          selector: '[name="' + name.replace(/"/g, '\\"') + '"]',
          name,
        });
        continue;
      }
    }

    const label = rawLabel(el);
    const combobox =
      el.getAttribute('role') === 'combobox' ||
      /select__input/.test(el.className) ||
      el.getAttribute('aria-autocomplete') === 'list';
    let kind;
    if (el.tagName === 'TEXTAREA') kind = 'textarea';
    else if (el.tagName === 'SELECT') kind = el.multiple ? 'multiselect' : 'select';
    else if (datePicker) kind = 'date';
    else if (combobox) kind = 'combobox';
    else if (['email', 'tel', 'url', 'number', 'date', 'file', 'checkbox', 'radio'].includes(type))
      kind = type;
    else kind = 'text';

    const key = keyFor(el, label);
    const field = {
      key,
      label: clean(label),
      kind,
      required: required(el, label),
      selector: selectorFor(el, key),
    };
    if (datePicker) field.picker = true;
    if (el.getAttribute('autocomplete') === 'tel-national') field.nationalPhone = true;
    if (el.tagName === 'SELECT')
      field.options = [...el.options]
        .map((o) => clean(o.textContent))
        .filter((t) => t && !/^select\b|^choose\b|^--/i.test(t));
    add(fields, el, field);
  }

  // Yes/No style questions rendered as buttons (Ashby): a labelled container with a few short
  // buttons and no visible inputs of its own (Ashby keeps a hidden checkbox behind the buttons).
  // Innermost containers first, so a wrapper around several questions never merges them.
  const usedButtons = new Set();
  const groupFields = [];
  // Survey builders (Infosys) nest each question of a multi-question card in its own
  // name="dynamicFields" block.
  for (const c of [
    ...ROOT.querySelectorAll(
      'fieldset, [class*="fieldEntry"], [class*="question"], [name="dynamicFields"]',
    ),
  ].reverse()) {
    if (!visible(c)) continue;
    // Hidden native upload inputs are still the actual control, already extracted above.
    if (c.querySelector('input[type="file"]')) continue;
    const ownInputs = [...c.querySelectorAll('input, textarea, select')].filter(
      (i) => (i.getAttribute('type') || '').toLowerCase() !== 'hidden' && visible(i),
    );
    if (ownInputs.length) continue;

    // An upload done through a button that opens the file picker, with no file input in the
    // page until it's clicked (photo uploads in survey builders).
    const uploadBtn = [...c.querySelectorAll('button, [role="button"]')].find(
      (b) =>
        visible(b) &&
        !usedButtons.has(b) &&
        /^(upload|attach|browse|choose|select)\b/i.test(clean(raw(b))),
    );
    if (uploadBtn && !c.querySelector('input[type="file"]')) {
      const labelText = labelIn(c, [uploadBtn]);
      if (clean(labelText)) {
        usedButtons.add(uploadBtn);
        const key = keyFor({ getAttribute: () => null }, labelText);
        c.setAttribute('data-ja-key', key);
        uploadBtn.setAttribute('data-ja-upload', '1');
        add(groupFields, c, {
          key,
          label: clean(labelText),
          kind: 'file',
          required: /[*✱]/.test(labelText) || !/optional/i.test(labelText),
          selector: '[data-ja-key="' + key.replace(/"/g, '\\"') + '"]',
          upload: 'chooser',
        });
        continue;
      }
    }

    let choices = [...c.querySelectorAll('button')]
      .filter((b) => visible(b) && clean(raw(b)).length <= 30)
      .map((b) => ({ el: b, text: clean(raw(b)) }));
    let multi = false;
    let tiles = false;
    if (choices.length < 2) {
      const t = choiceTiles(c);
      choices = t.choices;
      multi = t.multi;
      tiles = true;
    }
    if (choices.length < 2 || choices.length > (tiles ? 15 : 6)) continue;
    if (choices.some((b) => usedButtons.has(b.el))) continue; // already part of an inner question
    const labelText = labelIn(
      c,
      choices.map((b) => b.el),
    );
    if (!clean(labelText)) continue;
    choices.forEach((b) => usedButtons.add(b.el));
    const key = keyFor({ getAttribute: () => null }, labelText);
    c.setAttribute('data-ja-key', key);
    choices.forEach((b) => b.el.setAttribute('data-ja-option', b.text));
    add(groupFields, c, {
      key,
      label: clean(labelText),
      kind: multi ? 'checkboxes' : 'buttons',
      // Survey builders rarely mark required questions in the markup: ask unless optional.
      required:
        /[*✱]/.test(labelText) ||
        c.getAttribute('aria-required') === 'true' ||
        (tiles && !/optional/i.test(labelText)),
      options: choices.map((b) => b.text),
      selector: '[data-ja-key="' + key.replace(/"/g, '\\"') + '"]',
    });
  }
  fields.push(...groupFields);
  fields.sort((a, b) => (before(elOf.get(a), elOf.get(b)) ? -1 : 1));
  return fields;

  // The question text inside a container, skipping the given controls.
  function labelIn(c, controls) {
    for (const sel of LABEL_SELECTORS) {
      const l = [...c.querySelectorAll(sel)].find(
        (x) => clean(raw(x)) && !controls.some((b) => x.contains(b) || b.contains(x)),
      );
      if (l) return raw(l);
    }
    return '';
  }

  // Choices drawn as clickable tiles instead of inputs: ARIA radios/checkboxes, or elements
  // with a radio/checkbox icon (Material icon ligatures) next to the option text.
  function choiceTiles(c) {
    // Option text without icon ligatures ("check_circle YES" → "YES").
    const textOf = (el) => {
      let t = raw(el);
      for (const i of el.querySelectorAll('mat-icon, .material-icons, [class*="material-icons"]'))
        t = t.replace(raw(i), ' ');
      return clean(t);
    };
    // ARIA radios/checkboxes, or chips: options of a listbox shown inline (not a dropdown
    // panel, which lives in an overlay). A multi-select list ("XII Standard", "Diploma") is a
    // set of checkboxes.
    const aria = [
      ...c.querySelectorAll(
        '[role="radio"], [role="checkbox"], [role="listbox"] > * > [role="option"], [role="listbox"] > [role="option"]',
      ),
    ].filter((el) => visible(el) && !el.closest('.cdk-overlay-container'));
    if (aria.length >= 2)
      return {
        choices: aria.map((el) => ({ el, text: textOf(el) })).filter((x) => x.text),
        multi:
          aria[0].getAttribute('role') === 'checkbox' ||
          aria[0].closest('[role="listbox"]')?.getAttribute('aria-multiselectable') === 'true',
      };
    // Infosys changes the icon of a selected choice. Enumerate the option containers, not
    // just unchecked-icon glyphs, or the selected answer disappears during the next scan.
    const surveyTiles = [...c.querySelectorAll('.input-container')]
      .filter((el) => visible(el) && el.querySelector('.optiondiv'))
      .map((el) => ({ el, text: textOf(el) }))
      .filter((choice) => choice.text);
    if (surveyTiles.length >= 2)
      return {
        choices: surveyTiles,
        multi: surveyTiles.some(({ el }) => /check_box/.test(raw(el.querySelector('mat-icon')))),
      };
    const ICON =
      /^(radio_button_(un)?checked|check_box(_outline_blank)?|check_box_outline|circle|panorama_fish_eye)$/;
    const out = [];
    let multi = false;
    for (const icon of c.querySelectorAll('mat-icon, i, span[class*="icon"]')) {
      const t = clean(raw(icon));
      if (!ICON.test(t)) continue;
      if (/check_box/.test(t)) multi = true;
      let tile = icon.parentElement;
      for (let i = 0; i < 4 && tile && tile !== c; i++, tile = tile.parentElement) {
        const text = clean(raw(tile).replace(t, ''));
        if (text) {
          if (text.length <= 80 && visible(tile)) out.push({ el: tile, text });
          break;
        }
      }
    }
    return { choices: out, multi };
  }
})();
