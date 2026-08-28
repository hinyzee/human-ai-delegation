experiment_1_model <- "
model {
  beta0 ~ dnorm(0, 1 / (1.5 * 1.5))

  for (e in 1:2) {
    betaT[e] ~ dnorm(0, 1)
    mH0[e] ~ dunif(1, 50)
    mR0[e] ~ dunif(1, 50)
    a_raw[e] ~ dnorm(0, 2)
    alpha[e] <- 1 / (1 + exp(-a_raw[e]))
    kappa[e] ~ dbeta(2, 2)
  }

  for (i in 1:N) {
    mR[i, 1] <- mR0[experiment[i, 1]]
    mH[i, 1] <- mH0[experiment[i, 1]]

    for (t in 1:T) {
      eta[i, t] <- beta0 + betaT[experiment[i, t]] * (mH[i, t] - mR[i, t])
      p[i, t] <- 1 / (1 + exp(-eta[i, t]))
      y[i, t] ~ dbern(p[i, t])

      mR_raw[i, t + 1] <- mR[i, t] + alpha[experiment[i, 1]] * y[i, t] * (x[i, t] - mR[i, t])
      mH_raw[i, t + 1] <- mH[i, t] + alpha[experiment[i, 1]] * (1 - y[i, t]) * (x[i, t] - mH[i, t])

      mR[i, t + 1] <- (1 - reset_next[t]) * mR_raw[i, t + 1] +
        reset_next[t] * (kappa[experiment[i, 1]] * mR_raw[i, t + 1] +
        (1 - kappa[experiment[i, 1]]) * mR0[experiment[i, t]])
      mH[i, t + 1] <- (1 - reset_next[t]) * mH_raw[i, t + 1] +
        reset_next[t] * (kappa[experiment[i, 1]] * mH_raw[i, t + 1] +
        (1 - kappa[experiment[i, 1]]) * mH0[experiment[i, t]])

      y_pred[i, t] ~ dbern(p[i, t])
    }
  }
}
"

experiment_2_model <- "
model {
  beta0 ~ dnorm(0, 1 / (1.5 * 1.5))
  betaRR ~ dnorm(0, 1) T(0,)
  alpha ~ dbeta(2, 2)
  kappa ~ dbeta(2, 2)
  mAI0 ~ dnorm(1.5, 1) T(0, 5)
  mManual0 ~ dnorm(1.5, 1) T(0, 5)

  for (i in 1:N) {
    mAI[i, 1] <- mAI0
    mManual[i, 1] <- mManual0

    for (t in 1:T) {
      eta[i, t] <- beta0 + betaRR * (mAI[i, t] - mManual[i, t])
      p[i, t] <- 1 / (1 + exp(-eta[i, t]))
      y[i, t] ~ dbern(p[i, t])

      mAI_raw[i, t + 1] <- mAI[i, t] + alpha * y[i, t] * (x[i, t] - mAI[i, t])
      mManual_raw[i, t + 1] <- mManual[i, t] + alpha * (1 - y[i, t]) * (x[i, t] - mManual[i, t])
      mAI[i, t + 1] <- (1 - reset_next[t]) * mAI_raw[i, t + 1] +
        reset_next[t] * (kappa * mAI_raw[i, t + 1] + (1 - kappa) * mAI0)
      mManual[i, t + 1] <- (1 - reset_next[t]) * mManual_raw[i, t + 1] +
        reset_next[t] * (kappa * mManual_raw[i, t + 1] + (1 - kappa) * mManual0)

      y_pred[i, t] ~ dbern(p[i, t])
    }
  }
}
"

experiment_2_appendix_model <- function(use_beta0 = TRUE) {
  intercept <- if (use_beta0) "beta0 ~ dnorm(0, 1 / (1.5 * 1.5))" else ""
  eta <- if (use_beta0) {
    "eta[i, t] <- beta0 + sum(contribution[i, t, 1:D])"
  } else {
    "eta[i, t] <- sum(contribution[i, t, 1:D])"
  }

  sprintf("
model {
  %s
  alpha ~ dbeta(2, 2)
  kappa ~ dbeta(2, 2)

  for (d in 1:D) {
    beta[d] ~ dnorm(0, beta_prec[d]) T(0,)
    mAI0[d] ~ dnorm(m0_mean[d], m0_prec[d]) T(m0_lower[d], m0_upper[d])
    mManual0[d] ~ dnorm(m0_mean[d], m0_prec[d]) T(m0_lower[d], m0_upper[d])
  }

  for (i in 1:N) {
    for (d in 1:D) {
      mAI[i, 1, d] <- mAI0[d]
      mManual[i, 1, d] <- mManual0[d]
    }

    for (t in 1:T) {
      for (d in 1:D) {
        advantage[i, t, d] <- direction[d] * (mAI[i, t, d] - mManual[i, t, d])
        contribution[i, t, d] <- beta[d] * advantage[i, t, d]
      }

      %s
      p[i, t] <- 1 / (1 + exp(-eta[i, t]))
      y[i, t] ~ dbern(p[i, t])

      for (d in 1:D) {
        mAI_raw[i, t + 1, d] <- mAI[i, t, d] + alpha * y[i, t] * (x[i, t, d] - mAI[i, t, d])
        mManual_raw[i, t + 1, d] <- mManual[i, t, d] + alpha * (1 - y[i, t]) * (x[i, t, d] - mManual[i, t, d])
        mAI[i, t + 1, d] <- (1 - reset_next[t]) * mAI_raw[i, t + 1, d] +
          reset_next[t] * (kappa * mAI_raw[i, t + 1, d] + (1 - kappa) * mAI0[d])
        mManual[i, t + 1, d] <- (1 - reset_next[t]) * mManual_raw[i, t + 1, d] +
          reset_next[t] * (kappa * mManual_raw[i, t + 1, d] + (1 - kappa) * mManual0[d])
      }
    }
  }
}
", intercept, eta)
}

fit_jags <- function(data, model, monitor, inits, seed, chains, iter, burnin, thin) {
  set.seed(seed)
  fit <- R2jags::jags(
    data = data,
    inits = inits,
    parameters.to.save = monitor,
    model.file = textConnection(model),
    n.chains = chains,
    n.iter = iter,
    n.burnin = burnin,
    n.thin = thin
  )
  list(fit = fit, summary = fit$BUGSoutput$summary, posterior_draws = fit$BUGSoutput$sims.list)
}
