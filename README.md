# Human–AI Delegation

Code, data, and experimental materials for **“Deciding Whether to Delegate to AI: Time, Effort, and Repeated Experience.”**

This project examines how people decide whether to complete work themselves or delegate it to an automated agent. Across two behavioral experiments, we manipulate the time and effort associated with the two options and examine how delegation choices change with experience. The repository contains the browser experiments, cleaned analysis data, Bayesian models, posterior draws, and code used to generate the paper figures.

## Experiments

**Experiment 1: Package delivery.** Participants repeatedly chose whether to move a package themselves or delegate it to a robot. Separate time and effort versions isolate how the relative completion time and required work of the two options affect delegation.

**Experiment 2: Baggage screening.** Participants repeatedly chose between manually screening baggage X-rays and using AI assistance. The AI-assisted option varied in processing time and required review effort.

The browser experiments can be run locally for demonstration, but the original data-collection backend is not included.

## Repository structure

```text
human-ai-delegation/
├── experiments/
│   ├── experiment_1/
│   │   ├── effort/
│   │   └── time/
│   └── experiment_2/
│       └── stimuli/
├── data/
│   ├── experiment_1/
│   │   ├── effort_trials.csv
│   │   └── time_trials.csv
│   └── experiment_2/
│       └── batches.csv
├── analysis/
│   ├── models/
│   ├── results/
│   │   ├── experiment_1/
│   │   └── experiment_2/
│   └── figures/
│       ├── paper_figures.py
│       └── output/
├── .gitignore
├── requirements.txt
└── renv.lock
```

## Data and models

`data/` contains the cleaned, analysis-ready datasets used in the paper. Raw browser event logs are not included. Experiment 1 data are organized at the trial level, and Experiment 2 data are organized at the batch level.

The R and JAGS models are in `analysis/models/`:

- `experiment_1_model.R` models delegation in the package-delivery experiment.
- `experiment_2_model.R` models delegation in the baggage-screening experiment using experienced reward rate.
- `experiment_2_appendix.R` compares alternative specifications based on accuracy, time, effort, and reward rate.
- `model_specifications.R` contains the shared JAGS model definitions and fitting helper.

Compressed choice and belief trajectory draws are included under `analysis/results/`. They allow the figures to be reproduced without refitting the models.

## Reproducing the analyses

The R environment is recorded in `renv.lock`. Restore it in R, ensure JAGS is installed, and run:

```bash
Rscript analysis/models/experiment_1_model.R
Rscript analysis/models/experiment_2_model.R
Rscript analysis/models/experiment_2_appendix.R  # optional supplementary comparison
```

To generate the paper figures from the cleaned data and included posterior draws:

```bash
python -m pip install -r requirements.txt
python analysis/figures/paper_figures.py
```

Generated PNG and PDF files are written to `analysis/figures/output/`.
