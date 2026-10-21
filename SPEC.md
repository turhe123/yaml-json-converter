# YAML and JSON Converter — specification

**Tagline:** Validate YAML and convert it to JSON and back in your browser with exact error lines.

**Category:** Developer Tools

**Free alternative to:** Online YAML parsers and YAML to JSON sites (ad supported, paste goes to a server, poor error locations, only one direction)

**Search phrases:** yaml to json, json to yaml, yaml validator, yaml lint online, yaml formatter, convert yaml to json online, kubernetes yaml validator

**Allowed libraries:** js-yaml

**Published at:** https://turhe123.github.io/yaml-json-converter/

## Acceptance checks (each must have a test)

- pasting the bundled sample.yaml shows equivalent JSON on the right
- switching direction converts the sample JSON to YAML with 2 space indentation
- invalid YAML with a tab indent shows an error with line and column
- multiple documents separated by three dashes become a JSON array
- the copy and download buttons produce non empty output
- works at 390px wide

## Spec

yaml to json, json to yaml and yaml validator get consistently high search volume, driven by Kubernetes manifests, GitHub Actions, Docker Compose and OpenAPI files. The incumbent sites are generic converters crowded with ads. Many process the text on a server, and the pasted config often contains hostnames or secrets. Error reporting is weak on many of them, saying only bad indentation without a line number.

Our version does one job: convert between YAML and JSON and report mistakes clearly. Features: two linked editors with a direction switch, live conversion as you type, a validity badge, formatted output with indent choice of 2 or 4, key sorting option, support for multi document YAML, anchors and aliases resolved on conversion with a note when they were expanded, and a safe loading mode that refuses custom tags. For JSON to YAML the output style options are block style and flow style, and line width folding on or off. Dates in YAML that the parser turns into timestamps are shown as strings in JSON, in ISO form. Error messages show the line, column and a snippet with a caret, plus plain advice for frequent problems such as tabs used for indentation, missing space after a colon, and duplicate keys.

UI: two panes side by side on wide screens and stacked on phones. The top has a segmented control YAML to JSON or JSON to YAML, a Swap button that moves the output into the input and flips direction, and an options menu. Defaults: YAML to JSON, 2 space indent. A sample loads on first visit. File drop is supported for .yaml, .yml and .json. Copy and Download buttons name the file converted.json or converted.yaml, reusing the dropped name when there was one. Keyboard: Control or Command plus Enter forces a conversion, Control or Command plus S downloads.

Technical approach: use js-yaml for load, loadAll and dump, with the safe schema, and catch YAMLException to read its mark line and column for highlighting. JSON parse errors are handled by the native parser with a small helper to compute the line from the reported position. Conversion runs on input after a debounce of about 200 milliseconds. Very large documents over several MB are processed in a Web Worker. Output is displayed in a read only textarea with a monospaced style, no syntax highlighting library needed, though highlight.js could be added later. Nothing is stored or sent anywhere.

Edge cases: YAML values such as yes, no, on and off are treated as booleans or strings depending on the YAML version, so show a hint and let users pick the core schema. Octal like numbers and values with leading zeros must be preserved. Large integers beyond safe range are kept as strings with a warning. Unicode and emoji are preserved. A byte order mark is removed. Empty input shows a calm placeholder instead of an error. Mobile keyboards that auto insert smart quotes are guarded with attributes on the text areas.

Demo data: a fictional Docker Compose style file for a made up blog service with a web container, a database container, environment values, ports and a volume, along with a matching JSON version.
