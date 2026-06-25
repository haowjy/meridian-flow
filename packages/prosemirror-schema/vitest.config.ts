export default {
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        inline: ["lib0", "yjs"],
      },
    },
  },
};
