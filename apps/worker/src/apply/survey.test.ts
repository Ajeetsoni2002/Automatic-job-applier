/// <reference lib="dom" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { prepareContext } from './browser.js';
import { readFormFields } from './extract.js';
import { fillForm } from './fill.js';
import type { Answer, FormField } from './types.js';
import { walkForm } from './walk.js';

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const answer = (f: FormField, value: Answer['value']): Answer => ({
  ...f,
  value,
  source: 'user',
  needsInput: false,
  needsReview: false,
});

describe.skipIf(!fs.existsSync(chrome))('survey controls in Chrome', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  }, 30000);
  const open = async (html: string) => {
    await page?.context().close();
    const context = await browser.newContext();
    await prepareContext(context);
    page = await context.newPage();
    await page.setContent(html);
  };

  it('keeps a selected Infosys tile in the option list when its icon changes', async () => {
    await open(`<div class="question-card"><div class="display-text">GENDER</div>
      <div class="input-container" onclick="this.querySelector('mat-icon').textContent='check_circle'"><div class="optiondiv"><mat-icon>radio_button_unchecked</mat-icon></div><div class="optiondiv">MALE</div></div>
      <div class="input-container"><div class="optiondiv"><mat-icon>radio_button_unchecked</mat-icon></div><div class="optiondiv">FEMALE</div></div>
      <div class="input-container"><div class="optiondiv"><mat-icon>radio_button_unchecked</mat-icon></div><div class="optiondiv">I don't want to disclose</div></div></div>`);
    const first = await readFormFields(page);
    expect(await fillForm(page, first, [answer(first[0]!, 'MALE')])).toEqual([]);
    const next = await readFormFields(page);
    expect(next[0]?.options).toEqual(['MALE', 'FEMALE', "I don't want to disclose"]);
  });

  it('does not treat a dropdown search input as a new application question', async () => {
    await open(`<label for="office">Post Office *</label><mat-select id="office" style="display:block;height:24px" role="combobox" aria-controls="offices" aria-required="true"></mat-select>
      <div role="listbox" id="offices"><div role="option"><input placeholder="Search"></div><div role="option">Example Post Office</div></div>`);
    const fields = await readFormFields(page);
    expect(fields.map((f) => f.label)).toEqual(['Post Office']);
  });

  it('advances past personal details after a selected tile and a dependent dropdown change', async () => {
    await open(`<div class="question-card"><div class="display-text">GENDER</div>
      <div class="input-container" onclick="window.gender='MALE';this.querySelector('mat-icon').textContent='check_circle'"><div class="optiondiv"><mat-icon>radio_button_unchecked</mat-icon></div><div class="optiondiv">MALE</div></div>
      <div class="input-container"><div class="optiondiv"><mat-icon>radio_button_unchecked</mat-icon></div><div class="optiondiv">FEMALE</div></div>
      <div class="input-container"><div class="optiondiv"><mat-icon>radio_button_unchecked</mat-icon></div><div class="optiondiv">I don't want to disclose</div></div></div>
      <label for="pin">Pincode *</label><input id="pin" required oninput="document.querySelector('#offices').hidden=false">
      <div id="offices" hidden><label for="office">Post Office *</label><select id="office" required><option value="">Select</option><option>Example Post Office</option></select></div>
      <button onclick="if(window.gender==='MALE'&&document.querySelector('#office').value){document.body.innerHTML='<label for=college>College name *</label><input id=college required><button>Submit</button>'}">NEXT PAGE</button>`);
    const result = await walkForm(page.context(), page, {
      answersFor: async (fields) =>
        fields.map((f) => ({
          ...answer(
            f,
            f.label === 'GENDER'
              ? 'MALE'
              : f.key === 'pin'
                ? '123456'
                : f.key === 'office'
                  ? 'Example Post Office'
                  : '',
          ),
          needsInput: f.key === 'college' || (f.label === 'GENDER' && !f.options?.includes('MALE')),
        })),
      shouldSubmit: () => false,
      dryRun: true,
      headless: true,
      loginWaitMs: 0,
      captchaWaitMs: 0,
    });
    expect(result).toMatchObject({ outcome: 'needs_input', step: 1 });
    expect(await page.locator('#college').isVisible()).toBe(true);
  }, 30000);

  it('fills the input when its numeric id is also used by a question wrapper', async () => {
    await open(`<div id="142660095" class="question-card"><div class="display-text">First name</div>
      <input id="142660095" required></div>
      <div class="question-card"><div class="display-text">Upload your resume.</div>
      <input type="file" style="display:none" accept=".pdf"><button>Browse</button></div>`);
    const fields = await readFormFields(page);
    expect(await page.locator(fields[0]!.selector).evaluate((el) => el.tagName)).toBe('INPUT');
    const pdf = path.join(os.tmpdir(), 'ja-survey-resume.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4 test');
    try {
      expect(
        await fillForm(page, fields, [answer(fields[0]!, 'Test'), answer(fields[1]!, pdf)]),
      ).toEqual([]);
      expect(await page.locator('input:not([type=file])').inputValue()).toBe('Test');
      expect(
        await page
          .locator('input[type=file]')
          .evaluate((el) => (el as HTMLInputElement).files?.[0]?.name),
      ).toBe('ja-survey-resume.pdf');
      expect(fields.filter((f) => f.kind === 'file')).toHaveLength(1);
    } finally {
      fs.unlinkSync(pdf);
    }
  }, 20000);

  it('opens a photo editor, attaches an image, and confirms the editor before filling text', async () => {
    await open(`<div class="question-card"><div class="display-text">Upload recent passport size photo</div>
      <button onclick="document.querySelector('[role=dialog]').style.display='block'">Upload Image</button></div>
      <div role="dialog" style="display:none"><input type="file" accept="image/*" hidden onchange="window.uploaded=this.files[0].name">
      <button onclick="window.photo=window.uploaded;this.parentElement.style.display='none'">Done</button></div>
      <label for="name">First name</label><input id="name" required>`);
    const fields = await readFormFields(page);
    expect(fields.filter((f) => f.kind === 'file')).toHaveLength(1);
    const png = path.join(os.tmpdir(), 'ja-survey-photo.png');
    fs.writeFileSync(
      png,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    try {
      expect(
        await fillForm(
          page,
          fields,
          fields.map((f) => answer(f, f.kind === 'file' ? png : 'Test')),
        ),
      ).toEqual([]);
      expect(await page.evaluate('window.photo')).toBe('ja-survey-photo.png');
      expect(await page.locator('[role=dialog]').isVisible()).toBe(false);
      expect(await page.locator('#name').inputValue()).toBe('Test');
    } finally {
      fs.unlinkSync(png);
    }
  }, 20000);

  it('reads and selects a Material dropdown without typing into a non-editable element', async () => {
    await open(`<div class="question-card"><div class="display-text">Post Office</div>
      <mat-select style="display:block;min-height:24px" role="combobox" aria-required="true" aria-controls="offices" onclick="document.querySelector('#offices').hidden=false"></mat-select>
      <div id="offices" role="listbox" hidden><div role="option" onclick="document.querySelector('mat-select').textContent=this.textContent;this.parentElement.hidden=true">Sector 62</div>
      <div role="option" onclick="document.querySelector('mat-select').textContent=this.textContent;this.parentElement.hidden=true">Sector 63</div></div></div>`);
    const fields = await readFormFields(page);
    expect(fields).toMatchObject([
      {
        label: 'Post Office',
        kind: 'combobox',
        required: true,
        options: ['Sector 62', 'Sector 63'],
      },
    ]);
    expect(await fillForm(page, fields, [answer(fields[0]!, 'Sector 63')])).toEqual([]);
    expect(await page.locator('mat-select').textContent()).toBe('Sector 63');
  });

  it('selects from an already-open Material dropdown and closes it after reading', async () => {
    await open(`<label for="degree">Degree *</label><mat-select id="degree" tabindex="0" style="display:block;height:24px" role="combobox" aria-expanded="true" aria-controls="degrees"
      onclick="const next=this.getAttribute('aria-expanded')!=='true';this.setAttribute('aria-expanded',String(next));document.querySelector('#degrees').hidden=!next"></mat-select>
      <div id="degrees" role="listbox"><div role="option" onclick="document.querySelector('#degree').textContent=this.textContent;document.querySelector('#degree').setAttribute('aria-expanded','false');this.parentElement.hidden=true">Bachelor of Technology</div></div>`);
    const degree: FormField = {
      key: 'degree',
      label: 'Degree',
      kind: 'combobox',
      required: true,
      selector: '#degree',
      options: ['Bachelor of Technology'],
    };
    expect(await fillForm(page, [degree], [answer(degree, 'Bachelor of Technology')])).toEqual([]);
    expect(await page.locator('#degree').textContent()).toBe('Bachelor of Technology');
    await readFormFields(page);
    expect(await page.locator('#degree').getAttribute('aria-expanded')).toBe('false');
  }, 20000);

  it('reopens a dropdown dismissed by a pending blur or layout update', async () => {
    await open(`<label for="degree">Degree *</label><mat-select id="degree" tabindex="0" style="display:block;height:24px" role="combobox" aria-expanded="false" aria-controls="degrees"
      onclick="this.setAttribute('aria-expanded','true');document.querySelector('#degrees').hidden=false;if(!window.opened){window.opened=true;setTimeout(()=>{this.setAttribute('aria-expanded','false');document.querySelector('#degrees').hidden=true},100)}"></mat-select>
      <div id="degrees" role="listbox" hidden><div role="option" onclick="document.querySelector('#degree').textContent=this.textContent;this.parentElement.hidden=true">Bachelor of Technology</div></div>`);
    const degree: FormField = {
      key: 'degree',
      label: 'Degree',
      kind: 'combobox',
      required: true,
      selector: '#degree',
      options: ['Bachelor of Technology'],
    };
    expect(await fillForm(page, [degree], [answer(degree, 'Bachelor of Technology')])).toEqual([]);
    expect(await page.locator('#degree').textContent()).toBe('Bachelor of Technology');
  }, 20000);

  it('searches a virtualized dropdown for a saved option outside its rendered window', async () => {
    await open(`<label for="office">Post Office *</label><mat-select id="office" tabindex="0" style="display:block;height:24px" role="combobox" aria-expanded="false" aria-controls="offices" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#offices').hidden=false"></mat-select>
      <div id="offices" role="listbox" hidden><div role="option"><input placeholder="Search" onkeyup="setTimeout(()=>document.querySelector('#result').hidden=this.value!=='Pachaur',700)"></div>
      <div role="option">Bandha</div><div id="result" role="option" hidden onclick="document.querySelector('#office').textContent=this.textContent;this.parentElement.hidden=true">Pachaur</div></div>`);
    const office: FormField = {
      key: 'office',
      label: 'Post Office',
      kind: 'combobox',
      required: true,
      selector: '#office',
      options: ['Bandha'],
      searchable: true,
    };
    expect(await fillForm(page, [office], [answer(office, 'Pachaur')])).toEqual([]);
    expect(await page.locator('#office').textContent()).toBe('Pachaur');
  }, 20000);

  it('does not choose a different longer degree when the exact searched degree is unavailable', async () => {
    await open(`<label for="degree">Degree *</label><mat-select id="degree" tabindex="0" style="display:block;height:24px" role="combobox" aria-expanded="false" aria-controls="degrees" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#degrees').hidden=false"></mat-select>
      <div id="degrees" role="listbox" hidden><div role="option"><input placeholder="Search"></div><div role="option" onclick="window.chosen=this.textContent">Bachelor of Technology (Honours)</div></div>`);
    const degree: FormField = {
      key: 'degree',
      label: 'Degree',
      kind: 'combobox',
      required: true,
      selector: '#degree',
      options: [],
      searchable: true,
    };
    expect(await fillForm(page, [degree], [answer(degree, 'Bachelor of Technology')])).toHaveLength(
      1,
    );
    expect(await page.evaluate('window.chosen')).toBeUndefined();
  }, 20000);

  it.each([{value:'India (91)',query:'India'},{value:'+91',query:'+91'}])('searches a country phone code without changing its value ($value)', async ({value,query}) => {
    await open(`<label for="code">Country Code *</label><mat-select id="code" tabindex="0" style="display:block;height:24px" role="combobox" aria-expanded="false" aria-controls="countries" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#countries').hidden=false"></mat-select>
      <div id="countries" role="listbox" hidden><div role="option"><input placeholder="Search" onkeyup="document.querySelector('#india').hidden=this.value!=='${query}'"></div><div role="option" id="india" hidden onclick="document.querySelector('#code').textContent=this.textContent;this.parentElement.hidden=true">${value}</div></div>`);
    const code: FormField = {
      key: 'code',
      label: 'Country Code',
      kind: 'combobox',
      required: true,
      selector: '#code',
      options: [],
      searchable: true,
    };
    expect(await fillForm(page, [code], [answer(code, value)])).toEqual([]);
    expect(await page.locator('#code').textContent()).toBe(value);
  }, 20000);

  it('leaves an already-selected exact country code unchanged', async () => {
    await open(
      `<mat-select id="code" style="display:block;height:24px" role="combobox" aria-invalid="false" onclick="window.clicks=(window.clicks||0)+1">India (91)</mat-select>`,
    );
    const code: FormField = {
      key: 'code',
      label: 'Country Code',
      kind: 'combobox',
      required: true,
      selector: '#code',
      options: ['India (91)'],
      searchable: true,
    };
    expect(await fillForm(page, [code], [answer(code, 'India (91)')])).toEqual([]);
    expect(await page.evaluate('window.clicks||0')).toBe(0);
  }, 20000);

  it('does not restart filling when only a searchable dropdown rendered window changes', async () => {
    await open(`<label for="office">Post Office *</label><mat-select id="office" tabindex="0" style="display:block;height:24px" role="combobox" aria-expanded="false" aria-controls="offices"
      onclick="const opened=this.getAttribute('aria-expanded')!=='true';this.setAttribute('aria-expanded',String(opened));document.querySelector('#offices').hidden=!opened;if(opened)document.querySelector('#sample').textContent='Visible place '+(window.count=(window.count||0)+1)"></mat-select>
      <div id="offices" role="listbox" hidden><div role="option"><input placeholder="Search"></div><div role="option" id="sample">Visible place 0</div>
      <div role="option" onclick="document.querySelector('#office').textContent=this.textContent;document.querySelector('#office').setAttribute('aria-expanded','false');this.parentElement.hidden=true">Pachaur</div></div><button>Submit</button>`);
    const result = await walkForm(page.context(), page, {
      answersFor: async (fields) => fields.map((f) => answer(f, 'Pachaur')),
      shouldSubmit: () => false,
      dryRun: true,
      headless: true,
      loginWaitMs: 0,
      captchaWaitMs: 0,
    });
    expect(result.outcome).toBe('ready');
  }, 30000);

  it('does not mistake inline passport chips for options of an empty Post Office dropdown', async () => {
    await open(`<label for="office">Post Office</label><mat-select id="office" style="display:block;height:24px" role="combobox" aria-required="true"></mat-select>
      <div role="listbox"><div role="option">YES</div><div role="option">NO</div></div>`);
    const fields = await readFormFields(page);
    expect(fields[0]).toMatchObject({ label: 'Post Office', kind: 'combobox' });
    expect(fields[0]?.options).toBeUndefined();
  });

  it('keeps day and month correct when a date picker parses month-first text', async () => {
    await open(`<div class="question-card"><h2 class="display-text">Date of Birth</h2>
      <input id="dob" readonly aria-haspopup="dialog" required oninput="const d=new Date(this.value);this.className=Number.isNaN(+d)?'ng-invalid':'';if(!Number.isNaN(+d)) window.chosen=[d.getFullYear(),d.getMonth()+1,d.getDate()]"></div>`);
    const fields = await readFormFields(page);
    expect(await fillForm(page, fields, [answer(fields[0]!, '2002-06-05')])).toEqual([]);
    expect(await page.evaluate('window.chosen')).toEqual([2002, 6, 5]);
  });

  it('reports an unmatched radio answer instead of silently claiming it filled the group', async () => {
    await open(
      '<fieldset><legend>Citizenship *</legend><label><input type="radio" name="citizen" value="in">India</label><label><input type="radio" name="citizen" value="other">Other</label></fieldset>',
    );
    const fields = await readFormFields(page);
    expect(await fillForm(page, fields, [answer(fields[0]!, 'Missing country')])).toHaveLength(1);
    expect(await page.locator('input:checked').count()).toBe(0);
  });

  it('fills known answers before pausing for missing personal details', async () => {
    await open(
      '<label for="name">First name *</label><input id="name" required><label for="dob">Date of Birth *</label><input id="dob" required><button>Submit</button>',
    );
    const result = await walkForm(page.context(), page, {
      answersFor: async (fields) =>
        fields.map((f) => ({
          ...answer(f, f.key === 'name' ? 'Test' : ''),
          needsInput: f.key === 'dob',
        })),
      shouldSubmit: () => false,
      dryRun: true,
      headless: true,
      loginWaitMs: 0,
      captchaWaitMs: 0,
    });
    expect(result.outcome).toBe('needs_input');
    expect(await page.locator('#name').inputValue()).toBe('Test');
    expect(await page.locator('#dob').inputValue()).toBe('');
  });

  it('detects questions revealed by an answer before considering a page ready', async () => {
    await open(`<label for="name">First name *</label><input id="name" required>
      <label for="pin">Pincode *</label><input id="pin" required oninput="document.querySelector('#extra').hidden=false">
      <div id="extra" hidden><label for="office">Post Office *</label><select id="office" required><option value="">Select</option><option>Sector 62</option><option>Sector 63</option></select></div><button>Submit</button>`);
    const result = await walkForm(page.context(), page, {
      answersFor: async (fields) =>
        fields.map((f) => ({
          ...answer(f, f.key === 'name' ? 'Test' : f.key === 'pin' ? '201301' : ''),
          needsInput: f.key === 'office',
        })),
      shouldSubmit: () => false,
      dryRun: true,
      headless: true,
      loginWaitMs: 0,
      captchaWaitMs: 0,
    });
    expect(result.outcome).toBe('needs_input');
    expect(await page.locator('#office').inputValue()).toBe('');
  });

  it('opens the current job rather than a later Apply link in related jobs', async () => {
    await open(`<h1>Software Engineer</h1><button onclick="document.body.innerHTML='<label for=name>First name *</label><input id=name required><label for=mail>Email *</label><input id=mail required><button>Submit</button>'">Apply now</button>
      <aside><h2>Related jobs</h2><button onclick="document.body.textContent='Wrong job opened'">Apply now</button></aside>`);
    const result = await walkForm(page.context(), page, {
      answersFor: async (fields) =>
        fields.map((f) => answer(f, f.key === 'name' ? 'Test' : 'test@example.com')),
      shouldSubmit: () => false,
      dryRun: true,
      headless: true,
      loginWaitMs: 0,
      captchaWaitMs: 0,
    });
    expect(result.outcome).toBe('ready');
    expect(await page.locator('#name').inputValue()).toBe('Test');
  }, 25000);

  it('reads Microsoft question headings without hidden instructions and preserves required radio questions', async () => {
    await open(`<div data-automation-id="questionItem"><div id="q1"><span role="heading">1. Full Name</span><span aria-hidden="true">Single line text.</span></div>
      <input aria-labelledby="q1 info" aria-required="true"><span id="info" aria-hidden="true">Single line text.</span></div>
      <div data-automation-id="questionItem"><div id="q2"><span role="heading">6. Are you open to work as a trainer?</span><span aria-hidden="true">Single choice.</span><span data-automation-id="requiredStar" aria-hidden="false"></span></div>
      <div role="radiogroup" aria-labelledby="q2"><label><input type="radio" name="trainer" value="Yes">Yes</label><label><input type="radio" name="trainer" value="No">No</label></div></div>`);
    const fields = await readFormFields(page);
    expect(fields.map((f) => [f.label, f.kind, f.required])).toEqual([
      ['Full Name', 'text', true],
      ['Are you open to work as a trainer?', 'radio', true],
    ]);
  });

  it('uses the radio group question rather than an option or a page heading', async () => {
    await open(`<h1>You are applying for -</h1><div aria-required="true" role="radiogroup">
      <label>Have you ever been issued a Cisco Employee ID?</label>
      <div role="radiogroup" aria-label="Have you ever been issued a Cisco Employee ID?">
        <label><input type="radio" name="prior" value="Yes">Yes</label><label><input type="radio" name="prior" value="No">No</label></div></div>`);
    expect(await readFormFields(page)).toMatchObject([
      { label: 'Have you ever been issued a Cisco Employee ID?', required: true },
    ]);
  });

  it('recognises resume wrappers and keeps a national phone label outside survey cards', async () => {
    await open(`<h2 role="heading">phoneWidget</h2><div class="resume-upload-wrapper"><input type="file" hidden><button>Upload from PC</button></div>
      <label for="phone">Phone Number *</label><input id="phone" aria-label="Phone Number" autocomplete="tel-national" required>`);
    expect(await readFormFields(page)).toMatchObject([
      { label: 'Resume/CV', kind: 'file' },
      { label: 'Phone Number', kind: 'text', nationalPhone: true },
    ]);
  });

  it('detects Next progress on pages made entirely of choice tiles', async () => {
    await open(`<div class="question-card"><h2 class="question-title">Willing to relocate?</h2><button>Yes</button><button>No</button></div>
      <button onclick="document.querySelector('h2').textContent='Willing to work shifts?';this.textContent='Submit';this.onclick=null">Next</button>`);
    const labels: string[] = [];
    const result = await walkForm(page.context(), page, {
      answersFor: async (fields) => {
        labels.push(...fields.map((f) => f.label));
        return fields.map((f) => answer(f, 'Yes'));
      },
      shouldSubmit: () => false,
      dryRun: true,
      headless: true,
      loginWaitMs: 0,
      captchaWaitMs: 0,
    });
    expect(result).toMatchObject({ outcome: 'ready', step: 1 });
    expect(labels).toContain('Willing to work shifts?');
  }, 30000);

  // Infosys education page: multi-question cards whose questions repeat per section.
  const title = (text: string) =>
    `<jhi-question-title><div class="title-container"><div class="display-text"><span>${text}</span></div></div></jhi-question-title>`;
  const tile = (text: string) =>
    `<div class="input-container notselected" onclick="this.querySelector('mat-icon').textContent='check_circle'"><div class="optiondiv"><mat-icon>radio_button_unchecked</mat-icon></div><div class="optiondiv">${text}</div></div>`;
  const dropdown = (id: string, label: string, value = '') =>
    `<div name="dynamicFields" id="${id}"><jhi-dropdown-preview>${title(label)}<mat-form-field>
      <mat-select role="combobox" id="${id}" style="display:block;height:24px" aria-required="true" aria-labelledby="l${id} v${id}"><div id="v${id}"><span>${value}</span></div></mat-select>
      <label id="l${id}" for="${id}"><mat-label> </mat-label><span aria-hidden="true"> *</span></label></mat-form-field></jhi-dropdown-preview></div>`;
  const section = (heading: string, questions: string) =>
    `<mat-card class="question-card"><jhi-multi-question-preview class="question-tag"><div class="row">${title(heading)}</div>
      <div class="row">${questions}</div></jhi-multi-question-preview></mat-card>`;

  it('reads Infosys education sections, dropdown labels and inline choices', async () => {
    await open(`${section(
      'X/SSLC/Junior/Equivalent',
      `<div name="dynamicFields" id="180"><jhi-radio-buttons-preview>${title('Degree')}${tile('Secondary School Leaving Cert.')}${tile('Others')}</jhi-radio-buttons-preview></div>
        ${dropdown('184', 'Country', 'India')}${dropdown('182', 'Board')}`,
    )}
      <mat-card class="question-card"><jhi-checkbox-preview class="question-tag">${title('Please provide either Class XII or Diploma details.')}
        <mat-selection-list role="listbox" aria-multiselectable="true">
          <mat-list-option style="display:block" role="option" aria-selected="false" onclick="this.setAttribute('aria-selected',String(this.getAttribute('aria-selected')!=='true'))"><div class="mat-list-text">XII Standard</div></mat-list-option>
          <mat-list-option style="display:block" role="option" aria-selected="false"><div class="mat-list-text">Diploma</div></mat-list-option>
        </mat-selection-list></jhi-checkbox-preview></mat-card>
      ${section('XII Standard', dropdown('190', 'Board'))}`);
    const fields = await readFormFields(page);
    expect(fields.map((f) => [f.section, f.label, f.kind])).toEqual([
      ['X/SSLC/Junior/Equivalent', 'Degree', 'buttons'],
      ['X/SSLC/Junior/Equivalent', 'Country', 'combobox'],
      ['X/SSLC/Junior/Equivalent', 'Board', 'combobox'],
      [undefined, 'Please provide either Class XII or Diploma details.', 'checkboxes'],
      ['XII Standard', 'Board', 'combobox'],
    ]);
    expect(fields[0]?.options).toEqual(['Secondary School Leaving Cert.', 'Others']);
    expect(fields[3]?.options).toEqual(['XII Standard', 'Diploma']);

    // Filling a ticked choice again (a later rescan) must not untick it.
    const choice = answer(fields[3]!, ['XII Standard']);
    expect(await fillForm(page, fields, [choice])).toEqual([]);
    expect(await fillForm(page, await readFormFields(page), [choice])).toEqual([]);
    expect(
      await page.locator('mat-list-option', { hasText: 'XII Standard' }).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('finds a differently written option by searching narrower queries', async () => {
    await open(`<label for="inst">Institute *</label>
      <mat-select id="inst" tabindex="0" style="display:block;height:24px" role="combobox" aria-expanded="false" aria-controls="insts" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#insts').hidden=false"></mat-select>
      <div id="insts" role="listbox" hidden><div role="option"><input placeholder="Search"></div><div id="results"></div></div>
      <script>
        const pool = ['Computer Applications', 'Computer Engineering', 'Computer Science', 'Computer Science & Technology', 'Computer Science Engineering',
          'University Institute Of Technology', 'University Institute Of Technology, Sample University', 'University Institute Of Technology, Rgpv'];
        const show = (q) => {
          // A server-side search that renders only its first three results.
          const hits = pool.filter((o) => o.toLowerCase().includes(q.toLowerCase())).slice(0, 3);
          document.querySelector('#results').innerHTML = hits.map((h) => '<div role="option">' + h + '</div>').join('');
          for (const el of document.querySelectorAll('#results [role=option]'))
            el.onclick = () => { document.querySelector('#inst').textContent = el.textContent; document.querySelector('#inst').setAttribute('aria-expanded', 'false'); document.querySelector('#insts').hidden = true; };
        };
        document.querySelector('#insts input').onkeyup = (e) => setTimeout(() => show(e.target.value), 300);
        show('');
      </script>`);
    const inst: FormField = {
      key: 'inst',
      label: 'Institute',
      kind: 'combobox',
      required: true,
      selector: '#inst',
      options: [],
      searchable: true,
    };
    const college = 'University Institute of Technology, Sample University, Indore';
    expect(await fillForm(page, [inst], [answer(inst, college)])).toEqual([]);
    expect(await page.locator('#inst').textContent()).toBe(
      'University Institute Of Technology, Sample University',
    );
    await page.evaluate(() => (document.querySelector('#inst')!.textContent = ''));
    expect(
      await fillForm(page, [inst], [answer(inst, 'Computer Science and Engineering')]),
    ).toEqual([]);
    expect(await page.locator('#inst').textContent()).toBe('Computer Science Engineering');
  }, 60000);

  it('types a month-year date the picker shows correctly, rejecting misread formats', async () => {
    // Like Infosys: MM/YYYY only; a day-first date becomes the wrong year, anything else 01/2026.
    await open(`<div class="question-card"><h2 class="display-text">Passing month and year</h2>
      <input id="pass" readonly aria-haspopup="dialog" required onchange="
        const p=(n)=>String(n).padStart(2,'0');
        let m=this.value.match(/^(\\d{1,2})\\/(\\d{4})$/), d=this.value.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/);
        this.value = m ? p(m[1])+'/'+m[2] : d ? p(d[1])+'/20'+p(d[2]) : '01/2026';"></div>`);
    const fields = await readFormFields(page);
    expect(await fillForm(page, fields, [answer(fields[0]!, '2019-06-01')])).toEqual([]);
    expect(await page.locator('#pass').inputValue()).toBe('06/2019');
    expect(await fillForm(page, fields, [answer(fields[0]!, 'June 2025')])).toEqual([]);
    expect(await page.locator('#pass').inputValue()).toBe('06/2025');
  }, 30000);

  it('chooses again when a reused list element selected a neighbouring option', async () => {
    // The first click lands on an element the virtual list has already reused for another college.
    await open(`<label for="inst">Institute *</label>
      <mat-select id="inst" tabindex="0" style="display:block;height:24px" role="combobox" aria-expanded="false" aria-controls="insts"
        onclick="this.setAttribute('aria-expanded','true');document.querySelector('#insts').hidden=false"></mat-select>
      <div id="insts" role="listbox" hidden>
        <div role="option">University Institute Of Technology, Sample University</div>
        <div role="option">University Institute Of Technology, Rgpv</div></div>
      <script>
        for (const el of document.querySelectorAll('#insts [role=option]'))
          el.onclick = () => {
            const box = document.querySelector('#inst');
            box.textContent = window.clicked ? el.textContent : 'University Institute Of Chemical Technology, North Maharashtra University';
            window.clicked = (window.clicked || 0) + 1;
            box.setAttribute('aria-expanded', 'false');
            document.querySelector('#insts').hidden = true;
          };
      </script>`);
    const inst: FormField = {
      key: 'inst',
      label: 'Institute',
      kind: 'combobox',
      required: true,
      selector: '#inst',
      options: [],
    };
    const college = 'University Institute of Technology, Sample University, Indore';
    expect(await fillForm(page, [inst], [answer(inst, college)])).toEqual([]);
    expect(await page.locator('#inst').textContent()).toBe(
      'University Institute Of Technology, Sample University',
    );
    expect(await page.evaluate('window.clicked')).toBe(2);
  }, 30000);
});
