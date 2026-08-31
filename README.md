# How Time and Effort Shape Decisions to Delegate to AI

This repository contains the browser demos, cleaned data, analysis code, model outputs, and figures for the paper **“How Time and Effort Shape Decisions to Delegate to AI.”** The project examines how experienced costs shape decisions to complete work manually or delegate it to AI.

## Experiments

Experiment 1 uses a package-delivery task. Its two versions separately manipulate the relative effort and completion time of manual and robot-assisted work.

Experiment 2 uses a baggage-screening task. It varies AI processing time and the review effort required after AI assistance, creating different trade-offs between manual and AI-assisted work.

## Repository structure

```text
human-ai-delegation/
├── experiment_demos/
│   ├── experiment_1/
│   │   ├── effort/
│   │   └── time/
│   └── experiment_2/
│       └── stimuli/
├── data/
│   ├── experiment_1/
│   └── experiment_2/
├── analysis/
│   ├── model_specifications.R
│   ├── experiment_1_model.R
│   ├── experiment_2_model.R
│   ├── experiment_2_appendix.R
│   └── paper_figures.py
├── outputs/
│   ├── model_results/
│   │   ├── experiment_1/
│   │   └── experiment_2/
│   └── figures/
├── README.md
├── LICENSE
├── requirements.txt
└── renv.lock
```

- `experiment_demos/` contains the browser tasks and the stimuli used by Experiment 2.
- `data/` contains cleaned, analysis-ready trial data for both experiments. Raw browser event logs are not included.
- `analysis/` contains the JAGS model definitions, R model-fitting scripts, appendix analyses, and Python figure code.
- `outputs/` contains model-derived posterior summaries and generated paper figures.

The included posterior draws are sufficient to reproduce the model-based figures without refitting the JAGS models.

## Prerequisites

- R and JAGS, with the `R2jags` package available. The R package environment is recorded in `renv.lock` and can be restored with `renv::restore()`.
- Python 3. Python dependencies are listed in `requirements.txt` and can be installed with `python3 -m pip install -r requirements.txt`.

## Reproducing the figures

From the repository root, run:

```bash
python3 analysis/paper_figures.py
```

Figures and the generated summary table are written to `outputs/figures/`. To refit the models, run the R scripts in `analysis/`; their results are written to `outputs/model_results/`.

## Running the demos

Serve the repository with a local web server, then open the relevant HTML file under `experiment_demos/`. For example:

```bash
python3 -m http.server 8000
```

The demos reproduce the browser tasks but do not include the original data-collection backend. Responses are not saved.
