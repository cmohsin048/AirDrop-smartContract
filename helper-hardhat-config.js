const networkConfig = {
    default: {
        name: "hardhat",
        keepersUpdateInterval: "30",
    },
    31337: {
        name: "localhost",
        keepersUpdateInterval: "30",
    },
    11155111: {
        name: "sepolia",
        keepersUpdateInterval: "30",
    },
    1: {
        name: "mainnet",
        keepersUpdateInterval: "30",
    }
}

const developmentChains = ["hardhat", "localhost"]

module.exports = {
    networkConfig,
    developmentChains,
}