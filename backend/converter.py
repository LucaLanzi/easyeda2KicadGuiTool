"""
easyeda2KicadGuiTool - Python conversion backend.

Drives the easyeda2kicad library (https://github.com/uPesy/easyeda2kicad.py)
directly instead of through its CLI so that:

  * the symbol library, footprint library and 3D model folder can each be
    given their own name,
  * the 3D model path written into every footprint can be made relative to a
    chosen KiCad project folder (${KIPRJMOD}/...), independent of the current
    working directory,
  * the project's sym-lib-table / fp-lib-table can be updated automatically.

Usage (called by the Node.js server, job JSON on stdin, NDJSON events on stdout):

    python converter.py check
    python converter.py info     < {"ids": ["C2040"], "use_cache": false}
    python converter.py export   < {...export job...}
    python converter.py relink   < {...relink job...}
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import traceback
from pathlib import Path
from typing import Any

CURRENT_PART: str | None = None


# --------------------------------------------------------------------------- #
# NDJSON event output
# --------------------------------------------------------------------------- #
def send(event: str, **payload: Any) -> None:
    sys.stdout.write(json.dumps({"event": event, **payload}) + "\n")
    sys.stdout.flush()


class NdjsonLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            send(
                "log",
                level=record.levelname.lower(),
                message=record.getMessage(),
                part=CURRENT_PART,
            )
        except Exception:  # pragma: no cover - never break on logging
            pass


def setup_logging(debug: bool = False) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(logging.DEBUG if debug else logging.INFO)
    root.addHandler(NdjsonLogHandler())


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
LCSC_RE = re.compile(r"^C\d+$", re.IGNORECASE)
SAFE_NAME_RE = re.compile(r'^[^<>:"/\\|?*\x00-\x1f]+$')


def normalise_id(raw: str) -> str:
    raw = raw.strip().upper()
    if raw and raw[0].isdigit():
        raw = "C" + raw
    return raw


def check_name(name: str, what: str) -> str:
    name = (name or "").strip()
    if not name or not SAFE_NAME_RE.match(name) or name in (".", ".."):
        raise ValueError(f"Invalid {what} name: {name!r}")
    return name


def project_relative(target: Path, project_dir: Path | None) -> str | None:
    """Return '${KIPRJMOD}/rel/path' or None if it cannot be expressed."""
    if not project_dir:
        return None
    try:
        rel = os.path.relpath(target.resolve(), project_dir.resolve())
    except ValueError:  # different drive on Windows
        return None
    rel = Path(rel).as_posix()
    return "${KIPRJMOD}" if rel == "." else "${KIPRJMOD}/" + rel


def resolve_ref(
    target: Path, mode: str, project_dir: Path | None, custom_prefix: str = ""
) -> tuple[str, str | None]:
    """Compute how a path is referenced from KiCad. Returns (ref, warning)."""
    if mode == "project":
        ref = project_relative(target, project_dir)
        if ref is not None:
            return ref, None
        return (
            target.resolve().as_posix(),
            "Could not make the path project-relative (no project folder or a "
            "different drive) - an absolute path was used instead.",
        )
    if mode == "custom":
        prefix = custom_prefix.strip().rstrip("/")
        if not prefix:
            return target.resolve().as_posix(), "Custom prefix empty - absolute path used."
        return prefix, None
    return target.resolve().as_posix(), None


def upsert_lib_table(
    table_path: Path, kind: str, nickname: str, uri: str, descr: str
) -> str:
    """Add or update one library entry in a KiCad sym-lib-table / fp-lib-table."""
    entry = (
        f'  (lib (name "{nickname}")(type "KiCad")(uri "{uri}")'
        f'(options "")(descr "{descr}"))'
    )
    if table_path.exists():
        text = table_path.read_text(encoding="utf-8")
        pattern = re.compile(
            r'^[ \t]*\(lib \(name "?' + re.escape(nickname) + r'"?\).*$', re.M
        )
        if pattern.search(text):
            text = pattern.sub(lambda _m: entry, text, count=1)
            action = "updated"
        else:
            idx = text.rstrip().rfind(")")
            if idx < 0:
                raise ValueError(f"{table_path} does not look like a KiCad lib table")
            text = text[:idx].rstrip() + "\n" + entry + "\n)\n"
            action = "added"
    else:
        text = f"({kind}_lib_table\n  (version 7)\n{entry}\n)\n"
        action = "created"
    table_path.write_text(text, encoding="utf-8")
    return action


MODEL_RE = re.compile(r'\(model\s+"([^"]+)"|\(model\s+([^\s()]+)')


def relink_footprint_file(fp_file: Path, model_ref: str, model_ext: str) -> bool:
    """Rewrite the (model ...) path(s) of one .kicad_mod. Returns True if changed."""
    text = fp_file.read_text(encoding="utf-8")

    def repl(m: re.Match[str]) -> str:
        old = m.group(1) or m.group(2)
        stem = re.split(r"[\\/]", old)[-1]
        stem = re.sub(r"\.(wrl|step|stp|wrz)$", "", stem, flags=re.I)
        return f'(model "{model_ref}/{stem}.{model_ext}"'

    new_text = MODEL_RE.sub(repl, text)
    if new_text != text:
        fp_file.write_text(new_text, encoding="utf-8")
        return True
    return False


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def cmd_check(_: dict[str, Any]) -> int:
    try:
        from easyeda2kicad._version import __version__

        send("check", ok=True, python=sys.executable, pyversion=sys.version.split()[0],
             easyeda2kicad=__version__)
    except Exception as err:
        send("check", ok=False, python=sys.executable, pyversion=sys.version.split()[0],
             error=str(err))
    return 0


def cmd_info(job: dict[str, Any]) -> int:
    global CURRENT_PART
    from easyeda2kicad.easyeda.easyeda_api import EasyedaApi
    from easyeda2kicad.easyeda.easyeda_importer import (
        EasyedaFootprintImporter,
        EasyedaSymbolImporter,
    )
    from easyeda2kicad.easyeda.easyeda_svg_renderer import (
        render_footprint_svg,
        render_symbol_svg,
    )

    api = EasyedaApi(use_cache=bool(job.get("use_cache")))
    failures = 0
    for raw in job.get("ids", []):
        lcsc_id = normalise_id(raw)
        CURRENT_PART = lcsc_id
        try:
            cad = api.get_cad_data_of_component(lcsc_id=lcsc_id)
            if not cad:
                raise RuntimeError("No data returned by the EasyEDA API")
            sym = EasyedaSymbolImporter(easyeda_cp_cad_data=cad).get_symbol()
            fp = EasyedaFootprintImporter(easyeda_cp_cad_data=cad).get_footprint()
            info: dict[str, Any] = {
                "id": lcsc_id,
                "name": sym.info.name,
                "package": sym.info.package,
                "footprint": fp.info.name,
                "manufacturer": sym.info.manufacturer,
                "mpn": sym.info.mpn,
                "datasheet": sym.info.datasheet,
                "description": sym.info.description,
                "has_3d": fp.model_3d is not None,
                "model_name": fp.model_3d.name if fp.model_3d else None,
            }
            if job.get("svg", True):
                try:
                    info["symbol_svg"] = render_symbol_svg(cad)
                    info["footprint_svg"] = render_footprint_svg(cad)
                except Exception as err:
                    logging.warning(f"SVG preview failed: {err}")
            send("part_info", **info)
        except Exception as err:
            failures += 1
            send("part_info", id=lcsc_id, error=str(err))
    CURRENT_PART = None
    return 1 if failures else 0


def cmd_export(job: dict[str, Any]) -> int:
    global CURRENT_PART
    from easyeda2kicad.easyeda.easyeda_api import EasyedaApi
    from easyeda2kicad.easyeda.easyeda_importer import (
        Easyeda3dModelImporter,
        EasyedaFootprintImporter,
        EasyedaSymbolImporter,
    )
    from easyeda2kicad.easyeda.easyeda_svg_renderer import (
        render_footprint_svg,
        render_symbol_svg,
    )
    from easyeda2kicad.kicad.export_kicad_3d_model import Exporter3dModelKicad
    from easyeda2kicad.kicad.export_kicad_footprint import ExporterFootprintKicad
    from easyeda2kicad.kicad.export_kicad_symbol import ExporterSymbolKicad

    out_dir = Path(job["output_dir"]).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    project_dir = Path(job["project_dir"]).expanduser() if job.get("project_dir") else None
    if project_dir and not project_dir.is_dir():
        raise ValueError(f"KiCad project folder does not exist: {project_dir}")

    names = job.get("names", {})
    sym_name = check_name(names.get("symbol", "easyeda2kicad"), "symbol library")
    fp_name = check_name(names.get("footprint", sym_name), "footprint library")
    model_name = check_name(names.get("model", sym_name), "3D model folder")
    svg_name = check_name(names.get("svg", sym_name), "SVG folder")

    sym_path = out_dir / f"{sym_name}.kicad_sym"
    fp_dir = out_dir / f"{fp_name}.pretty"
    model_dir = out_dir / f"{model_name}.3dshapes"
    svg_dir = out_dir / f"{svg_name}.svgs"

    path_mode = job.get("model_path_mode", "project")
    model_ext = job.get("model_ext", "wrl")
    if model_ext not in ("wrl", "step"):
        raise ValueError("model_ext must be 'wrl' or 'step'")
    model_ref, ref_warning = resolve_ref(
        model_dir, path_mode, project_dir, job.get("custom_model_prefix", "")
    )
    if ref_warning:
        logging.warning(ref_warning)
    if model_ext == "step":
        logging.warning(
            "Footprints will reference .step models. easyeda2kicad does not bake the "
            "placement offset into STEP files, so some models may appear offset; "
            ".wrl is recommended."
        )

    overwrite = bool(job.get("overwrite"))
    custom_fields = {
        str(k).strip(): str(v).strip()
        for k, v in (job.get("custom_fields") or {}).items()
        if str(k).strip()
    }

    send(
        "paths",
        symbol_lib=str(sym_path),
        footprint_lib=str(fp_dir),
        model_dir=str(model_dir),
        svg_dir=str(svg_dir),
        model_ref=model_ref,
        model_ext=model_ext,
    )

    api = EasyedaApi(use_cache=bool(job.get("use_cache")))
    used = {"symbol": False, "footprint": False, "model": False}
    ok_count = fail_count = 0

    for part in job.get("parts", []):
        lcsc_id = normalise_id(str(part.get("id", "")))
        CURRENT_PART = lcsc_id
        result: dict[str, Any] = {"id": lcsc_id, "outputs": {}, "warnings": []}
        try:
            if not LCSC_RE.match(lcsc_id):
                raise ValueError("LCSC id should look like C2040")
            want_sym = bool(part.get("symbol"))
            want_fp = bool(part.get("footprint"))
            want_3d = bool(part.get("model3d"))
            want_svg = bool(part.get("svg"))
            if not any((want_sym, want_fp, want_3d, want_svg)):
                raise ValueError("Nothing selected (symbol / footprint / 3D / SVG)")

            send("part_start", id=lcsc_id)
            cad = api.get_cad_data_of_component(lcsc_id=lcsc_id)
            if not cad:
                raise RuntimeError("Failed to fetch data from EasyEDA API")

            if want_sym:
                ee_sym = EasyedaSymbolImporter(easyeda_cp_cad_data=cad).get_symbol()
                exporter = ExporterSymbolKicad(
                    symbol=ee_sym, lib_path=str(sym_path), custom_fields=custom_fields
                )
                if exporter.save_to_lib(
                    lib_path=str(sym_path), footprint_lib_name=fp_name, overwrite=overwrite
                ):
                    result["outputs"]["symbol"] = f"{sym_name}:{ee_sym.info.name}"
                    logging.info(f"Symbol {ee_sym.info.name} -> {sym_path.name}")
                else:
                    result["warnings"].append("Symbol already exists (enable overwrite)")
                    result["outputs"]["symbol"] = f"{sym_name}:{ee_sym.info.name} (kept)"
                used["symbol"] = True

            if want_fp:
                ee_fp = EasyedaFootprintImporter(easyeda_cp_cad_data=cad).get_footprint()
                fp_file = fp_dir / f"{ee_fp.info.name}.kicad_mod"
                if fp_file.is_file() and not overwrite:
                    result["warnings"].append("Footprint already exists (enable overwrite)")
                    result["outputs"]["footprint"] = f"{fp_name}:{ee_fp.info.name} (kept)"
                else:
                    ExporterFootprintKicad(footprint=ee_fp).export(
                        footprint_full_path=str(fp_file),
                        model_3d_path=model_ref,
                        model_3d_extension=model_ext,
                    )
                    result["outputs"]["footprint"] = f"{fp_name}:{ee_fp.info.name}"
                    if ee_fp.model_3d is not None:
                        result["outputs"]["model_ref"] = (
                            f"{model_ref}/{ee_fp.model_3d.name}.{model_ext}"
                        )
                    logging.info(f"Footprint {ee_fp.info.name} -> {fp_dir.name}")
                used["footprint"] = True

            if want_3d:
                exporter3d = Exporter3dModelKicad(
                    model_3d=Easyeda3dModelImporter(
                        easyeda_cp_cad_data=cad, download_raw_3d_model=True, api=api
                    ).output
                )
                if not exporter3d.output:
                    result["warnings"].append("No 3D model available on EasyEDA")
                elif exporter3d.export(output_dir=str(model_dir), overwrite=overwrite):
                    result["outputs"]["model"] = exporter3d.output.name
                    logging.info(f"3D model {exporter3d.output.name} -> {model_dir.name}")
                    used["model"] = True
                else:
                    result["warnings"].append("3D model already exists (enable overwrite)")
                    result["outputs"]["model"] = f"{exporter3d.output.name} (kept)"
                    used["model"] = True

            if want_svg:
                svg_dir.mkdir(parents=True, exist_ok=True)
                s_path = svg_dir / f"{lcsc_id}_symbol.svg"
                f_path = svg_dir / f"{lcsc_id}_footprint.svg"
                s_path.write_text(render_symbol_svg(cad), encoding="utf-8")
                f_path.write_text(render_footprint_svg(cad), encoding="utf-8")
                result["outputs"]["svg"] = [str(s_path), str(f_path)]
                logging.info(f"SVGs -> {svg_dir.name}")

            result["status"] = "warning" if result["warnings"] else "ok"
            ok_count += 1
        except Exception as err:
            result["status"] = "error"
            result["error"] = str(err)
            logging.debug(traceback.format_exc())
            fail_count += 1
        send("part_done", **result)

    CURRENT_PART = None

    # ---- project library tables ------------------------------------------ #
    tables: list[dict[str, str]] = []
    if job.get("update_lib_tables") and project_dir:
        descr = "Generated by easyeda2KicadGuiTool"
        if used["symbol"] or sym_path.exists():
            uri, _ = resolve_ref(sym_path, "project", project_dir)
            action = upsert_lib_table(project_dir / "sym-lib-table", "sym", sym_name, uri, descr)
            tables.append({"table": "sym-lib-table", "name": sym_name, "uri": uri, "action": action})
        if used["footprint"] or fp_dir.exists():
            uri, _ = resolve_ref(fp_dir, "project", project_dir)
            action = upsert_lib_table(project_dir / "fp-lib-table", "fp", fp_name, uri, descr)
            tables.append({"table": "fp-lib-table", "name": fp_name, "uri": uri, "action": action})
        for t in tables:
            logging.info(f"{t['table']}: {t['action']} '{t['name']}' -> {t['uri']}")
    elif job.get("update_lib_tables"):
        logging.warning("Library tables not updated: no KiCad project folder selected.")

    send("summary", ok=ok_count, failed=fail_count, tables=tables, model_ref=model_ref)
    return 1 if fail_count else 0


def cmd_relink(job: dict[str, Any]) -> int:
    """Rewrite 3D model paths of every footprint in an existing .pretty folder."""
    fp_dir = Path(job["footprint_dir"]).expanduser()
    model_dir = Path(job["model_dir"]).expanduser()
    project_dir = Path(job["project_dir"]).expanduser() if job.get("project_dir") else None
    model_ext = job.get("model_ext", "wrl")
    if not fp_dir.is_dir():
        raise ValueError(f"Footprint folder not found: {fp_dir}")
    model_ref, warning = resolve_ref(
        model_dir, job.get("model_path_mode", "project"), project_dir,
        job.get("custom_model_prefix", ""),
    )
    if warning:
        logging.warning(warning)
    changed = 0
    files = sorted(fp_dir.glob("*.kicad_mod"))
    for f in files:
        if relink_footprint_file(f, model_ref, model_ext):
            changed += 1
            logging.info(f"Relinked {f.name}")
    send("relink_done", total=len(files), changed=changed, model_ref=model_ref)
    return 0


COMMANDS = {"check": cmd_check, "info": cmd_info, "export": cmd_export, "relink": cmd_relink}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(f"usage: converter.py {{{','.join(COMMANDS)}}}", file=sys.stderr)
        return 2
    cmd = sys.argv[1]
    job: dict[str, Any] = {}
    if cmd != "check":
        raw = sys.stdin.buffer.read().decode("utf-8-sig")
        job = json.loads(raw) if raw.strip() else {}
    setup_logging(bool(job.get("debug")))
    try:
        return COMMANDS[cmd](job)
    except Exception as err:
        send("fatal", error=str(err), trace=traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
