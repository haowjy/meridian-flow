export default {
  test: {
    environment: "node",
    isolate: false,
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.bench.test.ts"],
  },
};
