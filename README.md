# Human–AI Delegation

Code, data, and experimental materials for **“How Time and Effort Shape Decisions to Delegate to AI.”**

This project examines how people decide whether to complete work themselves or delegate it to AI. Across two behavioral experiments, we manipulate differences in time and effort between the unassisted and AI-assisted workflows and examine how delegation choices change with experience.


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
│   └── experiment_2/
├── analysis/
│   ├── models/
│   ├── results/
│   │   ├── experiment_1/
│   │   └── experiment_2/
│   └── figures/
│       └── output/
├── README.md
├── requirements.txt
└── renv.lock
```

## Experiments

### Experiment 1

Experiment 1 uses a package-delivery task in which participants repeatedly choose whether to complete a task themselves or delegate it to a robot assistant.

Two versions of the experiment manipulate the relative costs of the two options. One varies completion time while holding effort approximately constant, and the other varies effort while holding completion time approximately constant.

The browser implementations are in `experiments/experiment_1/`.

### Experiment 2

Experiment 2 uses a baggage-screening task in which participants repeatedly choose between an unassisted workflow and an AI-assisted workflow.

The AI-assisted workflow varies in processing time and the amount of review required after the AI returns its output. These manipulations create different time and effort trade-offs between the two workflows.

The browser implementation and X-ray stimuli are in `experiments/experiment_2/`.

## Data

`data/` contains the cleaned, analysis-ready datasets used in the paper. Raw browser event logs are not included.

Experiment 1 data are organized at the trial level and contain participants' delegation choices and the time and effort experienced during each trial.

Experiment 2 data are also organized at the trial level and contain participants' delegation choices, task outcomes, completion time, effort, accuracy, and reward rate.

## Computational models

The modeling code is in `analysis/models/` and is implemented in R and JAGS.

```text
analysis/models/
├── model_specifications.R
├── experiment_1_model.R
├── experiment_2_model.R
└── experiment_2_appendix.R
```

`model_specifications.R` contains the JAGS model definitions.

`experiment_1_model.R` fits the model for Experiment 1. The model learns from experienced time and effort and estimates how these quantities influence subsequent delegation choices.

`experiment_2_model.R` fits the model for Experiment 2 using experienced reward rate.

`experiment_2_appendix.R` compares alternative model specifications based on accuracy, time, effort, and reward rate.

## Model results

Posterior draws used to generate the paper figures are included in `analysis/results/`.

```text
analysis/results/
├── experiment_1/
│   ├── choice_trajectories.csv.gz
│   └── belief_trajectories.csv.gz
└── experiment_2/
    ├── choice_trajectories.csv.gz
    └── belief_trajectories.csv.gz
```

These files allow the model-based figures to be reproduced without refitting the JAGS models.

## Figures

`analysis/figures/paper_figures.py` generates the main figures from the cleaned behavioral data and posterior model estimates.

Generated figures are saved in `analysis/figures/output/`.

## Reproducing the analyses

The R package environment is recorded in `renv.lock`. The models require R, JAGS, and `R2jags`.

Python dependencies for figure generation are listed in `requirements.txt`.

To reproduce the full analysis:

1. Restore the R environment.
2. Run `experiment_1_model.R` and `experiment_2_model.R`.
3. Run `experiment_2_appendix.R` for the model-comparison analyses.
4. Run `analysis/figures/paper_figures.py` to generate the figures.

The included posterior draws can be used to reproduce the figures without refitting the models.

## Running the experiments

The folders under `experiments/` contain the code and stimuli needed to run the behavioral tasks locally.

The original data-collection backend is not included. The browser experiments can therefore be run for demonstration, but participant responses are not saved unless a storage backend is connected.
