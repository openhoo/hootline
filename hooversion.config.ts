export default {
  branches: ["main"],
  packages: [
    {
      name: "hootline",
      path: ".",
      type: "node",
      manifest: "package.json",
      changelog: "CHANGELOG.md",
      scopes: ["hootline"],
      dependencies: [],
    },
  ],
  hooks: {
    afterVersion: ["npm install --package-lock-only --ignore-scripts"],
  },
  github: {
    releases: true,
  },
};
