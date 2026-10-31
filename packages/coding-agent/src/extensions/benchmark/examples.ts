/**
 * Example ladders shipped with pi, so nobody starts from a blank page.
 *
 * Each brings its own small files, so it runs in any folder and the answers are known. The last
 * step of a ladder, a real task, is the user's own; `/bench` adds it when they copy an example.
 */

import type { Ladder } from "./ladder.ts";

const LAB_FILES: Record<string, string> = {
	"data/header.txt": [
		"# Acquisition header, rig B",
		"operator = J. Rivera",
		"date = 2026-03-14",
		"channels = 4",
		"sample_rate = 48000 Hz",
		"bit_depth = 24",
		"gain_db = 12",
		"",
	].join("\n"),
	"data/pressure.csv": ["time_s,pressure_psi,temperature_c", "0,30,21.4", "10,40,21.9", "20,45.5,22.3", ""].join("\n"),
	"data/run_07.csv": ["time_s,temperature_c", "0,20.1", "60,22.8", "120,25.0", "180,26.4", "240,27.1", ""].join("\n"),
	"scripts/load_data.py": [
		"import pandas as pd",
		"",
		"def load(name):",
		"    return pd.read_csv(f'data/{name}.csv')",
		"",
	].join("\n"),
	"scripts/plot_overview.py": [
		"import matplotlib.pyplot as plt",
		"from load_data import load",
		"",
		"df = load('pressure')",
		"df.plot(x='time_s', y='pressure_psi')",
		"plt.savefig('figures/fig1.png')",
		"",
	].join("\n"),
	"scripts/summary_plots.py": [
		"import matplotlib.pyplot as plt",
		"from load_data import load",
		"",
		"df = load('run_07')",
		"df.plot(x='time_s', y='temperature_c')",
		"plt.savefig('figures/fig2.png')",
		"",
		"df.diff().plot(x='time_s', y='temperature_c')",
		"plt.title('Heating rate')",
		"plt.savefig('figures/fig3.png')",
		"",
	].join("\n"),
	"README.txt": "Rig B analysis. Data is in data/, scripts in scripts/, figures are written to figures/.\n",
};

const TEST_FILES: Record<string, string> = {
	"tests/beam_tests.csv": [
		"test_id,specimen,load_kN,deflection_mm,date",
		"T-101,A1,12.5,3.2,2026-01-05",
		"T-102,A2,,3.9,2026-01-05",
		"T-103,B1,15.0,4.4,05/01/2026",
		"T-104,B2,14.2,,2026-01-06",
		"T-105,C1,16.8,5.1,2026-01-07",
		"",
	].join("\n"),
	"tests/notes.md": [
		"# Beam test notes",
		"",
		"- T-103 was logged on the old laptop, so its date is day/month/year.",
		"- Specimen C1 is the reinforced design.",
		"",
	].join("\n"),
	"reports/q1_summary.txt":
		"Q1 summary: five beam tests, see tests/beam_tests.csv. Reinforced specimen tested last.\n",
};

export const EXAMPLE_LADDERS: Record<string, Ladder> = {
	"lab-data": {
		version: 1,
		name: "Example: lab data basics",
		description: "A header file, a few CSV files and plotting scripts, from reading one file to a script that runs.",
		files: LAB_FILES,
		tasks: [
			{
				id: "sample-rate",
				title: "Sample rate from a header",
				kind: "answer-from-file",
				prompt: "@data/header.txt What is the sample rate in this header?",
				files: ["data/header.txt"],
				level: 1,
				judge: "The header says 48000 Hz (48 kHz).",
				checks: [{ type: "answer-contains", text: "48" }],
			},
			{
				id: "figure-3",
				title: "Which script makes figure 3",
				kind: "find",
				prompt: "Which script in this folder makes figure 3?",
				files: [],
				level: 2,
				judge: "scripts/summary_plots.py saves figures/fig3.png. scripts/plot_overview.py only makes figure 1.",
				checks: [{ type: "answer-contains", text: "summary_plots.py" }],
			},
			{
				id: "psi-to-kpa",
				title: "Convert a column from psi to kPa",
				kind: "small-edit",
				prompt:
					"In data/pressure.csv, convert the pressure column from psi to kPa (1 psi = 6.895 kPa, round to one decimal) and rename its header to pressure_kpa. Leave the other columns as they are.",
				files: ["data/pressure.csv"],
				level: 3,
				judge: "The pressures should be 206.9, 275.8 and 313.7, the header pressure_kpa, and time and temperature unchanged.",
				checks: [
					{ type: "file-contains", path: "data/pressure.csv", text: "time_s,pressure_kpa,temperature_c" },
					{ type: "file-contains", path: "data/pressure.csv", text: "10,275.8,21.9" },
					{ type: "file-unchanged", path: "data/run_07.csv" },
				],
			},
			{
				id: "plot-run-07",
				title: "Write, run and check a plot script",
				kind: "multi-step",
				prompt:
					"Write a Python script plot_run07.py that plots temperature against time from data/run_07.csv, with axis labels including units, and saves it as run07.png. Run it, then check that the axis labels are right.",
				files: ["data/run_07.csv"],
				level: 3,
				judge: "The x axis should be time in seconds and the y axis temperature in °C. Open run07.png in the run's folder to check, if Python and matplotlib are installed.",
				checks: [
					{ type: "file-contains", path: "plot_run07.py", text: "xlabel" },
					{ type: "file-contains", path: "plot_run07.py", text: "ylabel" },
				],
			},
		],
	},
	"test-records": {
		version: 1,
		name: "Example: engineering test records",
		description: "A small table of beam tests with gaps and a wrong date, plus notes.",
		files: TEST_FILES,
		tasks: [
			{
				id: "missing-values",
				title: "Find the rows with missing values",
				kind: "answer-from-file",
				prompt: "@tests/beam_tests.csv Which tests have a missing value, and which value is missing?",
				files: ["tests/beam_tests.csv"],
				level: 1,
				judge: "T-102 has no load and T-104 has no deflection. No other row is missing anything.",
				checks: [
					{ type: "answer-contains", text: "T-102" },
					{ type: "answer-contains", text: "T-104" },
				],
			},
			{
				id: "reinforced",
				title: "Find which specimen is reinforced",
				kind: "find",
				prompt: "Which specimen is the reinforced design, and what was its load?",
				files: [],
				level: 2,
				judge: "C1 (from tests/notes.md), loaded to 16.8 kN in test T-105.",
				checks: [
					{ type: "answer-contains", text: "C1" },
					{ type: "answer-contains", text: "16.8" },
				],
			},
			{
				id: "fix-date",
				title: "Fix one date",
				kind: "small-edit",
				prompt:
					"One date in tests/beam_tests.csv is in a different format. Change it to YYYY-MM-DD like the others, and change nothing else.",
				files: ["tests/beam_tests.csv"],
				level: 3,
				judge: "T-103's date 05/01/2026 is day/month/year (see tests/notes.md), so it becomes 2026-01-05, not 2026-05-01.",
				checks: [
					{ type: "file-contains", path: "tests/beam_tests.csv", text: "T-103,B1,15.0,4.4,2026-01-05" },
					{ type: "file-unchanged", path: "tests/notes.md" },
				],
			},
			{
				id: "summary-script",
				title: "Write and run a summary script",
				kind: "multi-step",
				prompt:
					"Write a Python script summarize.py that prints the mean load and the mean deflection from tests/beam_tests.csv, skipping missing values. Run it and tell me the two numbers.",
				files: ["tests/beam_tests.csv"],
				level: 3,
				judge: "Mean load 14.625 kN (four values), mean deflection 4.15 mm (four values).",
				checks: [
					{ type: "answer-contains", text: "14.6" },
					{ type: "answer-contains", text: "4.15" },
				],
			},
		],
	},
};
