suppressPackageStartupMessages({
  library(tidyverse)
  library(R2jags)
})

args <- commandArgs(trailingOnly = FALSE)
script <- normalizePath(sub("--file=", "", args[grep("--file=", args)]))
model_dir <- dirname(script)
repo <- normalizePath(file.path(model_dir, "..", ".."))
out <- file.path(repo, "analysis", "results", "experiment_2")
dir.create(out, recursive = TRUE, showWarnings = FALSE)
source(file.path(model_dir, "model_specifications.R"))

data <- read.csv(file.path(repo, "data", "experiment_2", "batches.csv")) %>%
  mutate(
    t = as.integer(t),
    y = as.integer(y),
    accuracy = correct_count / n_trials,
    time = batch_time_sec / 60,
    effort = if_else(mode == "manual" | block_condition %in% c("effort_penalty", "full_suboptimal"), 1, 0),
    reward_rate = x_reward_rate / 5
  ) %>%
  arrange(subj_id, t) %>%
  group_by(subj_id) %>%
  filter(n() == 16) %>%
  ungroup()

catalog <- tribble(
  ~predictor, ~direction, ~beta_sd, ~m0_mean, ~m0_sd, ~lower, ~upper,
  "accuracy", 1, 1.0, 0.50, 0.25, 0.00, 1.00,
  "time", -1, 1.0, 0.75, 0.75, 0.00, 6.00,
  "effort", -1, 1.0, 0.50, 0.25, 0.00, 1.00,
  "reward_rate", 1, 1.0, 1.50, 1.00, 0.00, 5.00
)

signals <- list(
  S1 = c("accuracy"),
  S2 = c("reward_rate"),
  S3 = c("reward_rate", "effort"),
  S4 = c("accuracy", "time"),
  S5 = c("accuracy", "time", "effort"),
  S6 = c("time", "effort")
)

specs <- crossing(signal = names(signals), use_beta0 = c(TRUE, FALSE)) %>%
  mutate(model = paste(signal, if_else(use_beta0, "with beta0", "without beta0")))

make_input <- function(df, predictors) {
  spec <- catalog[match(predictors, catalog$predictor), ]
  model_data <- df %>% mutate(subj_row = dense_rank(subj_id))
  N <- n_distinct(model_data$subj_row)
  T <- 16L
  D <- length(predictors)

  y <- model_data %>%
    select(subj_row, t, y) %>%
    pivot_wider(names_from = t, values_from = y) %>%
    arrange(subj_row) %>%
    select(-subj_row) %>%
    as.matrix()

  x <- array(NA_real_, c(N, T, D))
  for (d in seq_len(D)) {
    x[, , d] <- model_data %>%
      select(subj_row, t, value = all_of(predictors[d])) %>%
      pivot_wider(names_from = t, values_from = value) %>%
      arrange(subj_row) %>%
      select(-subj_row) %>%
      as.matrix()
  }

  reset_next <- rep(0L, T)
  reset_next[8] <- 1L
  list(
    data = list(
      N = N,
      T = T,
      D = D,
      y = y,
      x = x,
      reset_next = reset_next,
      direction = spec$direction,
      beta_prec = 1 / spec$beta_sd^2,
      m0_mean = spec$m0_mean,
      m0_prec = 1 / spec$m0_sd^2,
      m0_lower = spec$lower,
      m0_upper = spec$upper
    ),
    rows = model_data
  )
}

make_inits <- function(input, use_beta0) {
  force(input)
  force(use_beta0)
  function() {
    init <- list(
      alpha = rbeta(1, 2, 2),
      kappa = rbeta(1, 2, 2),
      beta = pmax(abs(rnorm(input$D, 0, 0.35)), 0.01),
      mAI0 = pmin(pmax(rnorm(input$D, input$m0_mean, 0.5 / sqrt(input$m0_prec)), input$m0_lower + 1e-4), input$m0_upper - 1e-4),
      mManual0 = pmin(pmax(rnorm(input$D, input$m0_mean, 0.5 / sqrt(input$m0_prec)), input$m0_lower + 1e-4), input$m0_upper - 1e-4)
    )
    if (use_beta0) init$beta0 <- rnorm(1, 0, 0.5)
    init
  }
}

as_matrix <- function(x) {
  if (is.null(dim(x))) matrix(x, ncol = 1) else as.matrix(x)
}

predict_choices <- function(draws, input, use_beta0) {
  beta <- as_matrix(draws$beta)
  mAI0 <- as_matrix(draws$mAI0)
  mManual0 <- as_matrix(draws$mManual0)
  S <- length(draws$alpha)
  N <- input$N
  T <- input$T
  D <- input$D
  total <- matrix(0, N, T)

  for (s in seq_len(S)) {
    m_ai <- matrix(rep(mAI0[s, ], each = N), N, D)
    m_manual <- matrix(rep(mManual0[s, ], each = N), N, D)

    for (t in seq_len(T)) {
      advantage <- sweep(m_ai - m_manual, 2, input$direction, `*`)
      intercept <- if (use_beta0) draws$beta0[s] else 0
      total[, t] <- total[, t] + plogis(intercept + as.vector(advantage %*% beta[s, ]))

      for (d in seq_len(D)) {
        ai_raw <- m_ai[, d] + draws$alpha[s] * input$y[, t] * (input$x[, t, d] - m_ai[, d])
        manual_raw <- m_manual[, d] + draws$alpha[s] * (1 - input$y[, t]) * (input$x[, t, d] - m_manual[, d])
        if (input$reset_next[t] == 1L) {
          m_ai[, d] <- draws$kappa[s] * ai_raw + (1 - draws$kappa[s]) * mAI0[s, d]
          m_manual[, d] <- draws$kappa[s] * manual_raw + (1 - draws$kappa[s]) * mManual0[s, d]
        } else {
          m_ai[, d] <- ai_raw
          m_manual[, d] <- manual_raw
        }
      }
    }
  }
  total / S
}

set.seed(20260619)
folds <- data %>%
  distinct(subj_id, condition_pair) %>%
  arrange(condition_pair, subj_id) %>%
  group_by(condition_pair) %>%
  mutate(fold = sample(rep(1:5, length.out = n()))) %>%
  ungroup()

scores <- list()
diagnostics <- list()

for (fold_id in 1:5) {
  train <- data %>% semi_join(filter(folds, .data$fold != fold_id), by = "subj_id")
  test <- data %>% semi_join(filter(folds, .data$fold == fold_id), by = "subj_id")

  for (row in seq_len(nrow(specs))) {
    spec <- specs[row, ]
    predictors <- signals[[spec$signal]]
    train_input <- make_input(train, predictors)
    test_input <- make_input(test, predictors)
    monitor <- c("beta", "alpha", "kappa", "mAI0", "mManual0")
    if (spec$use_beta0) monitor <- c("beta0", monitor)

    fit <- fit_jags(
      train_input$data,
      experiment_2_appendix_model(spec$use_beta0),
      monitor,
      make_inits(train_input$data, spec$use_beta0),
      seed = 2200 + 100 * fold_id + row,
      chains = 3,
      iter = 6000,
      burnin = 2500,
      thin = 2
    )

    probability <- pmin(pmax(as.vector(predict_choices(fit$posterior_draws, test_input$data, spec$use_beta0)), 1e-12), 1 - 1e-12)
    outcome <- as.vector(test_input$data$y)
    log_score <- ifelse(outcome == 1, log(probability), log1p(-probability))
    scores[[length(scores) + 1]] <- tibble(
      model = spec$model,
      signal = spec$signal,
      use_beta0 = spec$use_beta0,
      fold = fold_id,
      n = length(outcome),
      elpd = sum(log_score),
      mean_log_score = mean(log_score),
      brier = mean((outcome - probability)^2),
      accuracy = mean((probability >= 0.5) == outcome)
    )

    summary <- as.data.frame(fit$summary)
    diagnostics[[length(diagnostics) + 1]] <- tibble(
      model = spec$model,
      fold = fold_id,
      max_rhat = max(summary$Rhat, na.rm = TRUE),
      min_ess = min(summary$n.eff, na.rm = TRUE)
    )
  }
}

fold_scores <- bind_rows(scores)
comparison <- fold_scores %>%
  group_by(model, signal, use_beta0) %>%
  summarise(
    n = sum(n),
    elpd = sum(elpd),
    mean_log_score = weighted.mean(mean_log_score, n),
    brier = weighted.mean(brier, n),
    accuracy = weighted.mean(accuracy, n),
    .groups = "drop"
  ) %>%
  mutate(delta_elpd = elpd - max(elpd)) %>%
  arrange(desc(elpd))

write.csv(comparison, file.path(out, "experiment_2_model_comparison.csv"), row.names = FALSE)
write.csv(fold_scores, file.path(out, "experiment_2_fold_scores.csv"), row.names = FALSE)
write.csv(bind_rows(diagnostics), file.path(out, "experiment_2_appendix_convergence.csv"), row.names = FALSE)
