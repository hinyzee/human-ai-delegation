# Delegation study publication repository

This repository contains the experiment demos, cleaned analysis data, final models, and the three figures reported in the paper. The demos preserve the task flow but contain no Firebase connection, API credentials, participant redirect, browser storage, or data export. Open-response questions are excluded.

## Structure

```text
experiments/
  experiment_1/
    time_manipulation/
    effort_manipulation/
  experiment_2/
data/
  experiment_1/
  experiment_2/
analysis/
  modeling/
    model_specifications.R
    experiment_1_model.R
    experiment_2_model.R
    experiment_2_appendix.R
    results/
  figures/
    paper_figures.py
    figure_1_preference_shift.{png,pdf}
    figure_2_delegation_trajectories.{png,pdf}
    figure_3_latent_belief_trajectories.{png,pdf}
requirements.txt
renv.lock
```

The paper figure mapping is:

- Figure 1: original `fig00`
- Figure 2: original `fig03`
- Figure 3: original `fig13`

## Data

`data/experiment_1` contains cleaned trial-level files for the time and effort manipulations. `data/experiment_2` contains cleaned batch-level reward-rate data and the condition-level trajectory summary. Participant identifiers are study-specific anonymous IDs; no free-text or recruitment-platform fields are included.

## Setup

Python 3.12 and R 4.4.2 were used. Install the Python environment with:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

The models require JAGS 4.3.2. Install JAGS with `brew install jags` on macOS or `sudo apt install jags` on Ubuntu. Restore the R packages with:

```r
install.packages("renv")
renv::restore()
```

A Dockerfile is not needed for this repository. `requirements.txt` covers Python packages, `renv.lock` covers R packages, and JAGS remains a system dependency.

## Run the analysis

From the repository root:

```bash
Rscript analysis/modeling/experiment_1_model.R
Rscript analysis/modeling/experiment_2_model.R
python analysis/figures/paper_figures.py
```

The appendix comparison is computationally expensive and runs separately:

```bash
Rscript analysis/modeling/experiment_2_appendix.R
```

The final posterior summaries needed by Figures 2 and 3 are retained in `analysis/modeling/results`. Full fitted model objects are generated locally and excluded from version control.

## Run the demos

Serve the repository locally because Experiment 2 loads stimulus metadata with relative requests:

```bash
python -m http.server 8000
```

Then open:

- `http://localhost:8000/experiments/experiment_1/time_manipulation/`
- `http://localhost:8000/experiments/experiment_1/effort_manipulation/`
- `http://localhost:8000/experiments/experiment_2/`
