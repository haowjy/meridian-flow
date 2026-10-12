export default {
  test: {
    environment: "node",
    // Reuse pure codecs as production does; test resolvers and registries are instance-owned.
    isolate: false,
    include: ["src/**/*.test.ts"],
  },
};
