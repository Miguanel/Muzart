// Okna dialogowe Aranżera Chronos (port z ChronosTimeline.kt).
import { h, clear, pickFile, downloadBlob } from "../util.js";
import { t } from "../i18n.js";
import { dialog as baseDialog, checkbox, radio, textField, trimEditor, parametricEQ, hSlider, toast, confirmDialog } from "../ui/components.js";
import { engine } from "../audio/engine.js";
import { dsp } from "../audio/dsp-client.js";
import { chronos } from "./store.js";

const cdialog = (o) => baseDialog({ ...o, className: `chronos-dialog ${o.className || ""}`.trim() });

const fmtBeat = (b) => (Math.round(b * 1000) / 1000).toString();

export function openAddTrackDialog() {
  let file = null;
  const name = textField(t("name"), `${t("track_default")} ${chronos.s.tracks.length + 1}`, { autofocus: true });
  const pickBtn = h("button.btn.primary.block", { type: "button", onclick: async () => {
    const f = await pickFile("audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac");
    if (f) { file = f; pickBtn.textContent = `🎵 ${t("selected")}: ${f.name}`; }
  } }, `🎤 ${t("import_audio")}`);
  cdialog({
    title: t("new_track"),
    content: [name.el, pickBtn],
    actions: [
      { label: t("cancel_lc"), variant: "text" },
      {
        label: t("add"), variant: "success",
        onClick: () => {
          const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
          chronos.addTrackWithId(id, name.input.value || `${t("track_default")} ${chronos.s.tracks.length + 1}`);
          if (file) chronos.importAudioClip(id, file).catch((e) => { console.error(e); toast(t("audio_import_failed")); });
        },
      },
    ],
  });
}

export function openTrackMenu(track) {
  const name = textField(t("name"), track.name, { autofocus: true });
  const idx = chronos.s.tracks.findIndex((x) => x.id === track.id);
  cdialog({
    title: track.name,
    content: [
      name.el,
      h("div.row.gap", null,
        h("button.btn.tonal", { type: "button", disabled: idx <= 0, onclick: () => chronos.moveTrack(track.id, true) }, "▲"),
        h("button.btn.tonal", { type: "button", disabled: idx >= chronos.s.tracks.length - 1, onclick: () => chronos.moveTrack(track.id, false) }, "▼"),
        h("button.btn.tonal", { type: "button", onclick: () => pickFile("audio/*").then((f) => f && chronos.importAudioClip(track.id, f).catch(() => toast(t("audio_import_failed")))) }, `🎵 ${t("import_audio")}`)),
    ],
    actions: [
      { label: t("delete"), variant: "danger-text", onClick: async () => {
        if (await confirmDialog({ title: t("delete"), message: t("delete_confirm"), confirmLabel: t("delete"), danger: true })) chronos.removeTrack(track.id);
      } },
      { label: t("cancel_lc"), variant: "text" },
      { label: t("save_lc"), variant: "primary", onClick: () => chronos.renameTrack(track.id, name.input.value.trim() || track.name) },
    ],
  });
}

export function openLinkMarkerDialog(clip) {
  let selected = clip.linkedMarkerId;
  let action = clip.linkedMarkerAction;
  const body = h("div.stack");
  const render = () => {
    clear(body);
    body.appendChild(h("p.muted.small", null, t("automation_hide_desc")));
    body.appendChild(radio("lnk", t("none_manual"), selected == null, () => { selected = null; render(); }));
    for (const m of chronos.tl.loopMarkers) body.appendChild(radio("lnk", t("breaker_at", { b: fmtBeat(m.beat) }), selected === m.id, () => { selected = m.id; render(); }));
    if (selected != null) {
      body.appendChild(h("hr.sep"));
      body.appendChild(h("p.muted.small", null, t("action_on_hit")));
      body.appendChild(h("div.seg", null, [["MUTE", "a_hide"], ["UNMUTE", "a_show"], ["TOGGLE", "a_toggle"]].map(([a, k]) =>
        h(`button.seg-btn${action === a ? ".active" : ""}`, { type: "button", onclick: () => { action = a; render(); } }, t(k)))));
    }
  };
  render();
  cdialog({
    title: t("automation_hide"),
    content: body,
    actions: [
      { label: t("cancel_lc"), variant: "text" },
      { label: t("save_link"), variant: "success", onClick: () => chronos.linkClipToMarker(clip.id, selected, action) },
    ],
  });
}

export function openAddMarkerDialog(beat) {
  let infinite = true;
  let type = "breaker";
  const count = h("input.input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: "3" });
  const countWrap = h("div.stack", { hidden: true },
    h("label.field", null, h("span.field-label", null, t("durability")), count),
    h("p.muted.small", null, t("durability_desc")));
  const info = h("p.muted.small", null, t("breaker_blocks_at", { b: fmtBeat(beat) }));
  const starterInfo = h("p.muted.small", { hidden: true }, t("starter_desc"));
  const typeSeg = h("div.seg");
  const renderType = () => {
    clear(typeSeg);
    [["breaker", "breaker"], ["starter", "starter"]].forEach(([v, k]) =>
      typeSeg.appendChild(h(`button.seg-btn${type === v ? ".active" : ""}`, { type: "button", onclick: () => { type = v; starterInfo.hidden = type !== "starter"; renderType(); } }, t(k))));
  };
  renderType();
  cdialog({
    title: t("add_breaker"),
    content: [
      h("div.field-label", null, t("marker_type")), typeSeg, starterInfo, info,
      checkbox(t("infinite_loop"), true, (v) => { infinite = v; countWrap.hidden = v; }),
      countWrap,
    ],
    actions: [
      { label: t("cancel_lc"), variant: "text" },
      {
        label: t("place"), variant: "success",
        onClick: () => {
          const max = infinite ? -1 : Math.max(1, parseInt(count.value, 10) || 1);
          if (type === "starter") chronos.addStarterMarker(beat, max);
          else chronos.addLoopMarker(beat, max);
        },
      },
    ],
  });
}

export function openEditMarkerDialog(marker, kind = "breaker") {
  let infinite = marker.maxLoops === -1;
  const count = h("input.input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: String(marker.maxLoops === -1 ? 3 : marker.maxLoops) });
  const countWrap = h("label.field", { hidden: infinite }, h("span.field-label", null, t("durability")), count);
  const isStarter = kind === "starter";
  cdialog({
    title: isStarter ? t("configure_starter") : t("configure_breaker"),
    content: [
      h("p.muted.small", null, t("stands_at", { b: fmtBeat(marker.beat) })),
      checkbox(t("infinite_loop"), infinite, (v) => { infinite = v; countWrap.hidden = v; }),
      countWrap,
    ],
    actions: [
      { label: t("cancel_lc"), variant: "text" },
      { label: t("delete"), variant: "danger", onClick: () => (isStarter ? chronos.removeStarterMarker(marker.id) : chronos.removeLoopMarker(marker.id)) },
      {
        label: t("update"), variant: "primary",
        onClick: () => {
          const max = infinite ? -1 : Math.max(1, parseInt(count.value, 10) || 1);
          isStarter ? chronos.updateStarterMarkerConfig(marker.id, max) : chronos.updateLoopMarkerConfig(marker.id, max);
        },
      },
    ],
  });
}

/** Port AdvancedClipEditorDialog — profile A/B, przycinanie, EQ z VU, echo, prędkość, cięcie twarde. */
export function openClipEditor(clip) {
  let [ts, te] = [clip.trimStart, clip.trimEnd];
  let delayMs = clip.delayMs;
  let speed = clip.speedFactor;
  let tab = "A";
  let eqA = Float32Array.from(clip.eqBands);
  let eqB = Float32Array.from(clip.altEqBands);
  let linked = clip.linkedEqMarkerId;
  let previewing = false, previewStart = 0, previewDur = 0, vuRaf = null;

  const waveFor = () => (tab === "A" ? clip.waveformData : clip.altWaveformData || clip.waveformData);

  const tabs = h("div.seg.profile-tabs");
  const profileB = h("div.stack");
  const trim = trimEditor({
    start: ts, end: te, height: Math.max(100, Math.min(200, window.innerHeight * 0.16)),
    onChange: (a, b) => { ts = a; te = b; },
    draw: (ctx, w, hh) => {
      const wf = waveFor();
      if (!wf || !wf.length) {
        ctx.fillStyle = "#888"; ctx.font = "11px system-ui"; ctx.textAlign = "center";
        ctx.fillText(t("generating_wave"), w / 2, hh / 2);
        return;
      }
      const bw = w / wf.length;
      ctx.beginPath();
      wf.forEach((a, i) => { const y = hh / 2 - a * hh * 0.4; i ? ctx.lineTo(i * bw, y) : ctx.moveTo(0, y); });
      for (let i = wf.length - 1; i >= 0; i--) ctx.lineTo(i * bw, hh / 2 + wf[i] * hh * 0.4);
      ctx.closePath();
      ctx.fillStyle = tab === "A" ? "rgba(99,102,241,0.8)" : "rgba(239,68,68,0.8)";
      ctx.fill();
    },
  });
  const eqHost = h("div.eq-host");
  const vu = h("canvas.vu");
  const eqRow = h("div.eq-row", null, eqHost, vu);

  function renderTabs() {
    clear(tabs);
    tabs.appendChild(h(`button.seg-btn${tab === "A" ? ".active" : ""}`, { type: "button", onclick: () => { tab = "A"; renderAll(); } }, t("profile_a")));
    tabs.appendChild(h(`button.seg-btn.red${tab === "B" ? ".active" : ""}`, { type: "button", onclick: () => { tab = "B"; renderAll(); } }, t("profile_b")));
    clear(profileB);
    profileB.hidden = tab !== "B";
    if (tab === "B") {
      profileB.appendChild(h("p.muted.small", null, t("profile_b_desc")));
      profileB.appendChild(radio("eqlnk", t("none_profile_a"), linked == null, () => { linked = null; }));
      for (const m of chronos.tl.loopMarkers) profileB.appendChild(radio("eqlnk", t("breaker_at", { b: fmtBeat(m.beat) }), linked === m.id, () => { linked = m.id; }));
    }
  }
  function renderEq() {
    clear(eqHost);
    eqHost.appendChild(parametricEQ(tab === "A" ? eqA : eqB, (g) => { if (tab === "A") eqA = g; else eqB = g; }));
  }
  function renderAll() { renderTabs(); renderEq(); trim.redraw(); }

  function drawVu() {
    const dpr = window.devicePixelRatio || 1;
    const r = vu.getBoundingClientRect();
    vu.width = Math.max(1, r.width * dpr); vu.height = Math.max(1, r.height * dpr);
    const c = vu.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#444"; c.fillRect(0, 0, r.width, r.height);
    let amp = 0;
    const wf = waveFor();
    if (previewing && wf?.length) {
      const p = (performance.now() - previewStart) / previewDur;
      if (p >= 1) { previewing = false; }
      else {
        const gains = tab === "A" ? eqA : eqB;
        const avg = gains.reduce((s, g) => s + g, 0) / gains.length;
        amp = Math.min(1, wf[Math.min(wf.length - 1, Math.floor(p * wf.length))] * avg);
      }
    }
    const g = c.createLinearGradient(0, r.height, 0, 0);
    g.addColorStop(0, "#22c55e"); g.addColorStop(0.8, "#eab308"); g.addColorStop(1, "#ef4444");
    c.fillStyle = g;
    c.fillRect(0, r.height * (1 - amp), r.width, r.height * amp);
    if (previewing) vuRaf = requestAnimationFrame(drawVu);
  }

  const delayLabel = h("div.slider-label", null, `${t("echo")}: ${delayMs}ms`);
  const speedLabel = h("div.slider-label", null, `${t("speed_label")}: ${speed.toFixed(2)}x`);

  const d = cdialog({
    title: null,
    size: "lg",
    className: "editor-dialog",
    onClose: () => { cancelAnimationFrame(vuRaf); engine.stop(`PREVIEW_${clip.id}`); },
    content: [
      tabs, profileB,
      h("div.section-label", null, t("trim_wave")),
      h("div.wave-box", null, trim),
      h("div.section-label", null, t("param_eq")),
      eqRow,
      h("div.row.two", null,
        h("div.col", null, delayLabel, hSlider({ value: delayMs, min: 0, max: 2000, step: 1, onInput: (v) => { delayMs = Math.round(v); delayLabel.textContent = `${t("echo")}: ${delayMs}ms`; } })),
        h("div.col", null, speedLabel, hSlider({ value: speed, min: 0.5, max: 2, step: 0.01, onInput: (v) => { speed = v; speedLabel.textContent = `${t("speed_label")}: ${speed.toFixed(2)}x`; } }))),
      h("div.row.between", null,
        h("button.btn.text", { type: "button", onclick: () => d.close() }, t("cancel_lc")),
        h("button.btn.tonal", { type: "button", onclick: async () => {
          const src = clip.originalPcmData || clip.pcmData;
          if (!src) return;
          await engine.unlock();
          const { pcm } = await dsp("process", { pcm: src, trimStart: ts, trimEnd: te, delayMs, speed, eq: Array.from(tab === "A" ? eqA : eqB) });
          engine.play(`PREVIEW_${clip.id}`, pcm, 1, { bus: "preview" });
          previewing = true; previewStart = performance.now(); previewDur = (pcm.length / 44100) * 1000;
          cancelAnimationFrame(vuRaf); drawVu();
        } }, t("preview_led"))),
      h("hr.sep"),
      h("p.muted.small", null, t("choose_save_method")),
      h("div.row.two", null,
        h("button.btn.danger.tall", { type: "button", onclick: () => { chronos.cropClipPermanently(clip.id, ts, te); d.close(); } },
          h("span", null, t("hard_cut")), h("small", null, t("hard_cut_sub"))),
        h("button.btn.success.tall", { type: "button", onclick: () => { chronos.applyAdvancedAudioProcessing(clip.id, ts, te, delayMs, speed, eqA, eqB, linked); d.close(); } },
          h("span", null, t("normal_save")), h("small", null, t("normal_save_sub")))),
    ],
    actions: [],
  });
  renderAll();
  requestAnimationFrame(() => { trim.redraw(); drawVu(); });
}

/** Port ProjectLibraryDialog — zapis, wczytywanie, eksport/import plików .mzt. */
export function openProjectLibrary() {
  const body = h("div.stack.project-lib");
  const d = cdialog({ title: t("lib_projects"), size: "md", content: body, actions: [] });
  const unsub = chronos.on("change", (p) => { if ("savedProjectsList" in p) renderList(); });
  const close = d.close;
  d.close = () => { unsub(); close(); };

  const name = textField(t("project_name"), chronos.s.projectName);
  const list = h("div.project-list");
  body.append(
    h("div.section-label.blue", null, t("current_project")),
    name.el,
    h("div.row.two", null,
      h("button.btn.success", { type: "button", onclick: async () => {
        const n = name.input.value.trim();
        if (!n) return;
        chronos.setProjectName(n);
        try { await chronos.saveProject(); toast(t("project_saved", { n })); } catch (e) { console.error(e); toast(String(e.message || e)); }
      } }, `💾 ${t("save_lc")}`),
      h("button.btn.danger", { type: "button", onclick: () => { chronos.clearProject(); d.close(); } }, `🧹 ${t("clear")}`)),
    h("hr.sep"),
    h("div.row.between", null,
      h("div.section-label.blue", null, t("saved_projects")),
      h("button.btn.tonal.small", { type: "button", onclick: async () => {
        const f = await pickFile(".mzt,.zip,application/zip,application/octet-stream");
        if (!f) return;
        try { const n = await chronos.importProjectFile(f); toast(t("project_imported", { n })); }
        catch (e) { console.error(e); toast(t("import_failed")); }
      } }, `⬇ ${t("import_lc")}`)),
    list,
    h("p.muted.small", null, t("android_import_note")));

  function renderList() {
    clear(list);
    const items = chronos.s.savedProjectsList;
    if (!items.length) { list.appendChild(h("div.empty", null, h("div.empty-icon", null, "📂"), t("no_saved_projects"))); return; }
    for (const pName of items) {
      list.appendChild(h("div.project-row", null,
        h("div.project-name", null, pName),
        h("div.row.gap", null,
          h("button.icon-btn.small", { type: "button", title: t("delete_project"), onclick: async () => {
            if (await confirmDialog({ title: t("delete_project"), message: t("delete_project_q", { n: pName }), confirmLabel: t("delete"), danger: true })) chronos.deleteProject(pName);
          } }, "🗑"),
          h("button.icon-btn.small", { type: "button", title: t("export"), onclick: async () => {
            const blob = await chronos.exportProject(pName);
            if (!blob) return;
            const file = new File([blob], `${pName}.mzt`, { type: "application/zip" });
            if (navigator.canShare?.({ files: [file] }) && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
              try { await navigator.share({ files: [file], title: pName }); return; } catch (e) { if (e?.name === "AbortError") return; }
            }
            downloadBlob(blob, `${pName}.mzt`);
          } }, "⬆"),
          h("button.btn.primary.small", { type: "button", onclick: async () => {
            try { await chronos.loadProject(pName); toast(t("project_loaded", { n: pName })); d.close(); }
            catch (e) { console.error(e); toast(t("import_failed")); }
          } }, t("load_lc")))));
    }
  }
  chronos.loadSavedProjectsList();
  renderList();
}
