suppressPackageStartupMessages({
  library(tidyverse)
  library(R2jags)
  library(coda)
})

args <- commandArgs(trailingOnly = FALSE)
script <- normalizePath(sub("--file=", "", args[grep("--file=", args)]))
model_dir <- dirname(script)
repo <- normalizePath(file.path(model_dir, ".."))
out <- file.path(repo, "outputs", "model_results", "experiment_1")
dir.create(out, recursive = TRUE, showWarnings = FALSE)
source(file.path(model_dir, "model_specifications.R"))

time_trials <- read.csv(file.path(repo, "data", "experiment_1", "time_trials.csv"))
effort_trials <- read.csv(file.path(repo, "data", "experiment_1", "effort_trials.csv"))

make_matrix <- function(data, value) {
  data %>%
    select(subj_idx, t, value = all_of(value)) %>%
    pivot_wider(names_from = t, values_from = value) %>%
    arrange(subj_idx) %>%
    select(-subj_idx) %>%
    as.matrix()
}

prepare_trials <- function(data, cost) {
  data %>%
    mutate(
      y = as.integer(select_robot),
      x = if (cost == "time") round_total_time_ms / 1000 else if_else(y == 1L, robot_errors_setting * 2, steps_to_complete),
      subj_idx = dense_rank(subj_id)
    ) %>%
    group_by(subj_idx) %>%
    arrange(round_index, .by_group = TRUE) %>%
    mutate(t = row_number()) %>%
    filter(n() == 16) %>%
    ungroup()
}

time_model <- prepare_trials(time_trials, "time")
effort_model <- prepare_trials(effort_trials, "effort")
n_time <- n_distinct(time_model$subj_idx)
n_effort <- n_distinct(effort_model$subj_idx)
T <- 16L

reset_next <- rep(0L, T)
reset_next[8] <- 1L
jags_data <- list(
  N = n_time + n_effort,
  T = T,
  y = rbind(make_matrix(time_model, "y"), make_matrix(effort_model, "y")),
  x = rbind(make_matrix(time_model, "x"), make_matrix(effort_model, "x")),
  experiment = rbind(matrix(1L, n_time, T), matrix(2L, n_effort, T)),
  reset_next = reset_next
)

inits <- function() {
  list(
    beta0 = rnorm(1, 0, 0.5),
    betaT = rnorm(2, 0, 0.5),
    a_raw = rnorm(2),
    mR0 = runif(2, 5, 25),
    mH0 = runif(2, 5, 25),
    kappa = rbeta(2, 2, 2)
  )
}

fit <- fit_jags(
  jags_data,
  experiment_1_model,
  c("beta0", "betaT", "alpha", "mR0", "mH0", "kappa", "y_pred", "mR", "mH"),
  inits,
  seed = 12,
  chains = 3,
  iter = 16000,
  burnin = 5000,
  thin = 2
)
saveRDS(fit, file.path(out, "experiment_1_fit.rds"))

convergence <- as.data.frame(fit$summary)
convergence$parameter <- rownames(convergence)
write.csv(convergence, file.path(out, "experiment_1_convergence.csv"), row.names = FALSE)

make_map <- function(data, version, offset = 0L) {
  data %>%
    group_by(subj_id) %>%
    filter(n() == 16) %>%
    ungroup() %>%
    mutate(subj_index = dense_rank(subj_id) + offset) %>%
    group_by(subj_id, block) %>%
    arrange(round_index, .by_group = TRUE) %>%
    mutate(block_start = min(round_index), trial = row_number()) %>%
    ungroup() %>%
    group_by(subj_id) %>%
    mutate(
      block_position = if_else(block_start == min(block_start), "First experienced condition", "Second experienced condition"),
      first_block = block[which.min(round_index)]
    ) %>%
    ungroup() %>%
    mutate(
      version = version,
      order = case_when(
        version == "Time version" & first_block == 1L ~ "Robot faster first",
        version == "Time version" ~ "Human faster first",
        version == "Effort version" & first_block == 1L ~ "Human easier first",
        TRUE ~ "Robot easier first"
      )
    ) %>%
    select(version, subj_index, round_index, trial, order, block_position)
}

trial_map <- bind_rows(
  make_map(time_trials, "Time version"),
  make_map(effort_trials, "Effort version", n_time)
)

as_draw_array <- function(draws, N, T) {
  dims <- dim(draws)
  if (length(dims) == 3 && all(dims[2:3] == c(N, T))) return(draws)
  if (length(dims) == 3 && all(dims[1:2] == c(N, T))) return(aperm(draws, c(3, 1, 2)))
  stop("Unexpected posterior dimensions")
}

aggregate_draws <- function(draws, map, value_name) {
  groups <- c("version", "order", "block_position", "trial")
  cells <- do.call(interaction, c(map[groups], drop = TRUE, sep = "___"))
  indices <- cbind(map$subj_index, map$round_index)
  values <- vapply(seq_len(dim(draws)[1]), function(draw) {
    tapply(draws[draw, , ][indices], cells, mean)
  }, numeric(nlevels(cells)))
  as_tibble(t(values), .name_repair = ~ levels(cells)) %>%
    mutate(draw = row_number()) %>%
    pivot_longer(-draw, names_to = "cell", values_to = value_name) %>%
    separate(cell, into = groups, sep = "___", convert = TRUE)
}

posterior <- fit$posterior_draws
y_draws <- as_draw_array(posterior$y_pred, jags_data$N, T)
trajectory <- aggregate_draws(y_draws, trial_map, "p_choose_agent") %>%
  mutate(model = "joint_onepar", .before = 1)

mR <- as_draw_array(posterior$mR[, , seq_len(T), drop = FALSE], jags_data$N, T)
mH <- as_draw_array(posterior$mH[, , seq_len(T), drop = FALSE], jags_data$N, T)
belief_states <- bind_rows(
  aggregate_draws(mR, trial_map, "belief") %>% mutate(option = "Robot"),
  aggregate_draws(mH, trial_map, "belief") %>% mutate(option = "Human")
) %>%
  mutate(
    model = "joint_onepar",
    cost = if_else(version == "Time version", "Completion time (s)", "Clicks"),
    .before = 1
  )

write.csv(trajectory, gzfile(file.path(out, "choice_trajectories.csv.gz")), row.names = FALSE)
write.csv(belief_states, gzfile(file.path(out, "belief_trajectories.csv.gz")), row.names = FALSE)
