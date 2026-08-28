suppressPackageStartupMessages({
  library(tidyverse)
  library(R2jags)
  library(coda)
})

args <- commandArgs(trailingOnly = FALSE)
script <- normalizePath(sub("--file=", "", args[grep("--file=", args)]))
model_dir <- dirname(script)
repo <- normalizePath(file.path(model_dir, "..", ".."))
out <- file.path(repo, "analysis", "results", "experiment_2")
dir.create(out, recursive = TRUE, showWarnings = FALSE)
source(file.path(model_dir, "model_specifications.R"))

data <- read.csv(file.path(repo, "data", "experiment_2", "batches.csv")) %>%
  arrange(subj_id, t) %>%
  group_by(subj_id) %>%
  filter(n() == 16) %>%
  ungroup() %>%
  mutate(
    subj_row = dense_rank(subj_id),
    y = as.integer(y),
    x = x_reward_rate / 5,
    station = if_else(block_index == 1L, "First station", "Second station"),
    batch = batch_within_block
  )

make_matrix <- function(value) {
  data %>%
    select(subj_row, t, value = all_of(value)) %>%
    pivot_wider(names_from = t, values_from = value) %>%
    arrange(subj_row) %>%
    select(-subj_row) %>%
    as.matrix()
}

N <- n_distinct(data$subj_row)
T <- 16L
reset_next <- rep(0L, T)
reset_next[8] <- 1L
jags_data <- list(N = N, T = T, y = make_matrix("y"), x = make_matrix("x"), reset_next = reset_next)

bounded_normal <- function(mean, sd, lower, upper) {
  pmin(pmax(rnorm(1, mean, sd), lower + 1e-4), upper - 1e-4)
}

inits <- function() {
  list(
    beta0 = rnorm(1, 0, 0.5),
    betaRR = pmax(abs(rnorm(1, 0, 0.35)), 0.01),
    alpha = rbeta(1, 2, 2),
    kappa = rbeta(1, 2, 2),
    mAI0 = bounded_normal(1.5, 0.5, 0, 5),
    mManual0 = bounded_normal(1.5, 0.5, 0, 5)
  )
}

fit <- fit_jags(
  jags_data,
  experiment_2_model,
  c("beta0", "betaRR", "alpha", "mAI0", "mManual0", "kappa", "y_pred", "mAI", "mManual"),
  inits,
  seed = 12,
  chains = 3,
  iter = 8000,
  burnin = 3000,
  thin = 2
)
saveRDS(fit, file.path(out, "experiment_2_fit.rds"))

convergence <- as.data.frame(fit$summary)
convergence$parameter <- rownames(convergence)
write.csv(convergence, file.path(out, "experiment_2_convergence.csv"), row.names = FALSE)

as_draw_array <- function(draws, N, T) {
  dims <- dim(draws)
  if (length(dims) == 3 && all(dims[2:3] == c(N, T))) return(draws)
  if (length(dims) == 3 && all(dims[1:2] == c(N, T))) return(aperm(draws, c(3, 1, 2)))
  stop("Unexpected posterior dimensions")
}

aggregate_draws <- function(draws, groups, value_name) {
  cells <- do.call(interaction, c(data[groups], drop = TRUE, sep = "___"))
  indices <- cbind(data$subj_row, data$t)
  values <- vapply(seq_len(dim(draws)[1]), function(draw) {
    tapply(draws[draw, , ][indices], cells, mean)
  }, numeric(nlevels(cells)))
  as_tibble(t(values), .name_repair = ~ levels(cells)) %>%
    mutate(draw = row_number()) %>%
    pivot_longer(-draw, names_to = "cell", values_to = value_name) %>%
    separate(cell, into = groups, sep = "___", convert = TRUE)
}

posterior <- fit$posterior_draws
y_draws <- as_draw_array(posterior$y_pred, N, T)
trajectory <- aggregate_draws(y_draws, c("first_condition", "station", "batch"), "p_choose_agent") %>%
  mutate(model = "reward_rate_shared_beta0", .before = 1)

mAI <- as_draw_array(posterior$mAI[, , seq_len(T), drop = FALSE], N, T)
mManual <- as_draw_array(posterior$mManual[, , seq_len(T), drop = FALSE], N, T)
belief_states <- bind_rows(
  aggregate_draws(mAI * 5, c("first_condition", "station", "batch"), "belief") %>% mutate(option = "AI"),
  aggregate_draws(mManual * 5, c("first_condition", "station", "batch"), "belief") %>% mutate(option = "Manual")
) %>%
  mutate(model = "reward_rate_shared_beta0", cost = "Reward rate (correct/min)", .before = 1)

write.csv(trajectory, gzfile(file.path(out, "choice_trajectories.csv.gz")), row.names = FALSE)
write.csv(belief_states, gzfile(file.path(out, "belief_trajectories.csv.gz")), row.names = FALSE)
