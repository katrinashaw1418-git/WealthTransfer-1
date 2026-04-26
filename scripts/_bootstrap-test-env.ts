process.env.NODE_ENV ??= "development";
process.env.ALLOW_LOCAL_DEV_AUTH ??= "true";

if (
  !process.env.JWT_SECRET &&
  !(
    process.env.NODE_ENV === "development" &&
    (process.env.APP_ENV === "local" ||
      process.env.ALLOW_LOCAL_DEV_AUTH === "true")
  )
) {
  throw new Error(
    "test bootstrap: cannot establish local-dev auth context — refuse to run."
  );
}

export {};
