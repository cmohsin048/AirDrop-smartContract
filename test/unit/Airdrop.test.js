const { assert, expect } = require("chai");
const { network, deployments, ethers } = require("hardhat");
const { developmentChains } = require("../../helper-hardhat-config");

!developmentChains.includes(network.name)
  ? describe.skip
  : describe("Airdrop Unit Tests", function () {
      let airdrop,
        tokenA,
        tokenB,
        owner,
        user1,
        user2,
        user3,
        user4,
        user5,
        user6,
        user7;
      const CONVERSION_RATIO = 5000; // 0.5 in basis points (10000)
      const TOKEN_B_MAX_CAP = ethers.parseEther("1000000");
      const MIN_PLEDGE_AMOUNT = ethers.parseEther("100");
      const PLEDGE_DURATION = 7 * 24 * 60 * 60; // 7 days
      const BASIS_POINTS = 10000;

      beforeEach(async () => {
        accounts = await ethers.getSigners();
        owner = accounts[0];
        user1 = accounts[1];
        user2 = accounts[2];
        user3 = accounts[3];
        user4 = accounts[4];
        user5 = accounts[5];
        user6 = accounts[6];
        user7 = accounts[7];

        // Deploy mock ERC20 tokens first
        const TokenMock = await ethers.getContractFactory("ERC20Mock");
        tokenA = await TokenMock.deploy("Token A", "TKA", 18);
        tokenB = await TokenMock.deploy("Token B", "TKB", 18);

        // Deploy Airdrop contract
        const Airdrop = await ethers.getContractFactory("Airdrop");
        airdrop = await Airdrop.deploy(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          CONVERSION_RATIO,
          TOKEN_B_MAX_CAP,
          MIN_PLEDGE_AMOUNT,
          PLEDGE_DURATION
        );

        // Mint tokens to users and approve airdrop contract
        await tokenA.mint(user1.address, ethers.parseEther("10000"));
        await tokenA.mint(user2.address, ethers.parseEther("10000"));
        await tokenB.mint(await airdrop.getAddress(), TOKEN_B_MAX_CAP);

        await tokenA
          .connect(user1)
          .approve(await airdrop.getAddress(), ethers.parseEther("10000"));
        await tokenA
          .connect(user2)
          .approve(await airdrop.getAddress(), ethers.parseEther("10000"));
      });
      describe("constructor", function () {
        it("initializes the airdrop correctly", async () => {
          assert.equal(await airdrop.getCurrentPhase(), 0); // PLEDGE phase
          assert.equal(await airdrop.getConversionRatio(), CONVERSION_RATIO);
          assert.equal(await airdrop.getTokenBMaxCap(), TOKEN_B_MAX_CAP);
          const [tokenADecimals, tokenBDecimals] =
            await airdrop.getTokenDecimals();
          assert.equal(tokenADecimals, 18);
          assert.equal(tokenBDecimals, 18);
        });
      });

      describe("pledgeTokens", function () {
        it("reverts when amount is below minimum", async () => {
          await expect(
            airdrop.connect(user1).pledgeTokens(ethers.parseEther("50"), 0)
          ).to.be.revertedWithCustomError(
            airdrop,
            "Airdrop__PledgeAmountTooLow"
          );
        });

        it("allows valid pledge and updates state correctly", async () => {
          const pledgeAmount = ethers.parseEther("1000");
          await airdrop.connect(user1).pledgeTokens(pledgeAmount, 0);

          const userPledge = await airdrop.getUserPledge(user1.address);
          assert.equal(userPledge[0], pledgeAmount); // tokenAAmount
          assert.equal(userPledge[2], false); // processed
          assert.equal(await airdrop.getTotalPledged(), pledgeAmount);
        });

        it("reverts when phase is not PLEDGE", async () => {
          await airdrop
            .connect(user1)
            .pledgeTokens(ethers.parseEther("1000"), 0);
          await network.provider.send("evm_increaseTime", [
            PLEDGE_DURATION + 1,
          ]);
          await network.provider.send("evm_mine");
          // Fast forward the phase transition time
          const minPhaseTime = await airdrop.getMinPhaseTransitionTime();
          await network.provider.send("evm_increaseTime", [
            Number(minPhaseTime),
          ]);
          await network.provider.send("evm_mine");
          await airdrop.finalizePledgePhase();

          await expect(
            airdrop.connect(user2).pledgeTokens(ethers.parseEther("1000"), 0)
          ).to.be.revertedWithCustomError(airdrop, "Airdrop__NotInPledgePhase");
        });
      });

      // Test modification
      describe("finalizePledgePhase", function () {
        beforeEach(async () => {
          // Fast forward the phase transition time
          const minPhaseTime = await airdrop.getMinPhaseTransitionTime();
          await network.provider.send("evm_increaseTime", [
            Number(minPhaseTime),
          ]);
          await network.provider.send("evm_mine");
        });

        it("sets correct scaling ratio when total required exceeds max cap", async () => {
          // First update the max pledge per user to allow larger pledges
          const newMaxPledge = ethers.parseEther("5000000");
          await airdrop.setMaxPledgePerUser(newMaxPledge);

          // Calculate pledge amount to exceed max cap based on conversion ratio
          // TOKEN_B_MAX_CAP is 1,000,000 tokens and conversion ratio is 0.5 (5000 basis points)
          // So we need to pledge more than 2,000,000 tokens to exceed the cap
          const pledgeAmount = ethers.parseEther("2000000");

          // Mint tokens to users
          await tokenA.mint(user1.address, pledgeAmount);
          await tokenA.mint(user2.address, pledgeAmount);

          // Approve spending
          await tokenA
            .connect(user1)
            .approve(await airdrop.getAddress(), pledgeAmount);
          await tokenA
            .connect(user2)
            .approve(await airdrop.getAddress(), pledgeAmount);

          // Users pledge tokens
          await airdrop.connect(user1).pledgeTokens(pledgeAmount, 0);
          await airdrop.connect(user2).pledgeTokens(pledgeAmount, 0);

          // Total pledged amount should exceed what's needed to hit max cap
          const totalPledged = await airdrop.getTotalPledged();
          const conversionRatio = await airdrop.getConversionRatio();
          const BASIS_POINTS = 10000;

          // Calculate total TokenB that would be required without scaling
          const totalTokenBRequired =
            (totalPledged * BigInt(conversionRatio)) / BigInt(BASIS_POINTS);
          const tokenBMaxCap = await airdrop.getTokenBMaxCap();

          // Verify we're actually exceeding max cap
          assert(
            totalTokenBRequired > tokenBMaxCap,
            "Total required should exceed max cap"
          );

          // Finalize pledge phase
          await airdrop.finalizePledgePhase();

          // Get actual scaling ratio
          const scalingRatio = await airdrop.getScalingRatio();

          // Calculate expected ratio
          const expectedRatio =
            (tokenBMaxCap * BigInt(BASIS_POINTS)) / totalTokenBRequired;

          // Verify scaling ratio is less than 100% (10000 basis points)
          assert(
            scalingRatio < 10000,
            "Scaling ratio should be less than 100%"
          );

          // Verify scaling ratio matches expected value
          assert.equal(
            scalingRatio,
            expectedRatio,
            "Scaling ratio should match expected value"
          );
        });
      });

      describe("processPledgeBatch", function () {
        beforeEach(async () => {
          await airdrop
            .connect(user1)
            .pledgeTokens(ethers.parseEther("1000"), 0);
          await airdrop
            .connect(user2)
            .pledgeTokens(ethers.parseEther("2000"), 0);
          // Fast forward the phase transition time
          const minPhaseTime = await airdrop.getMinPhaseTransitionTime();
          await network.provider.send("evm_increaseTime", [
            Number(minPhaseTime),
          ]);
          await network.provider.send("evm_mine");
          await airdrop.finalizePledgePhase();
        });

        it("processes pledges and distributes tokens correctly", async () => {
          const user1BalanceBefore = await tokenB.balanceOf(user1.address);
          await airdrop.processPledgeBatch(10);

          const userPledge = await airdrop.getUserPledge(user1.address);
          assert.equal(userPledge[2], true); // processed

          const user1BalanceAfter = await tokenB.balanceOf(user1.address);
          assert(user1BalanceAfter > user1BalanceBefore);
        });

        it("completes distribution and updates phase", async () => {
          await airdrop.processPledgeBatch(10);
          assert.equal(await airdrop.getCurrentPhase(), 2); // COMPLETED phase
        });
      });

      describe("emergency functions", function () {
        it("prevents non-emergency operations when paused", async () => {
          await airdrop.activateEmergencyMode();
          await expect(
            airdrop.connect(user1).pledgeTokens(ethers.parseEther("1000"), 0)
          ).to.be.revertedWithCustomError(airdrop, "EnforcedPause");
        });

        it("prevents operations when emergency mode is active", async () => {
          await airdrop.activateEmergencyMode(); // This also pauses the contract
          await expect(
            airdrop.connect(user1).pledgeTokens(ethers.parseEther("1000"), 0)
          ).to.be.revertedWithCustomError(airdrop, "EnforcedPause");
        });

        it("activates emergency mode correctly", async () => {
          await airdrop.activateEmergencyMode();
          assert.equal(await airdrop.isEmergencyMode(), true);
          assert.equal(await airdrop.paused(), true); // Should also be paused
        });

        it("allows emergency withdrawal only in emergency mode", async () => {
          await airdrop.activateEmergencyMode();
          const amount = ethers.parseEther("100");
          await tokenA.mint(await airdrop.getAddress(), amount);
          await expect(
            airdrop.emergencyWithdraw(
              await tokenA.getAddress(),
              owner.address,
              amount
            )
          ).to.not.be.reverted;
        });
      });

      describe("blacklist functions", function () {
        it("correctly blacklists and unblacklists addresses", async () => {
          await airdrop.setBlacklistStatus(user1.address, true);
          assert.equal(await airdrop.isBlacklisted(user1.address), true);

          await airdrop.setBlacklistStatus(user1.address, false);
          assert.equal(await airdrop.isBlacklisted(user1.address), false);
        });

        it("prevents blacklisted addresses from pledging", async () => {
          await airdrop.setBlacklistStatus(user1.address, true);
          await expect(
            airdrop.connect(user1).pledgeTokens(ethers.parseEther("1000"), 0)
          ).to.be.revertedWithCustomError(airdrop, "Airdrop__InvalidAddress");
        });
      });

      describe("configuration functions", function () {
        it("updates cooldown period correctly", async () => {
          const newPeriod = 2 * 60 * 60; // 2 hours
          await airdrop.setCooldownPeriod(newPeriod);
          assert.equal(await airdrop.getCooldownPeriod(), newPeriod);
        });

        it("updates max pledge per user correctly", async () => {
          const newMax = ethers.parseEther("5000");
          await airdrop.setMaxPledgePerUser(newMax);
          assert.equal(await airdrop.getMaxPledgePerUser(), newMax);
        });

        it("updates min dust amount correctly", async () => {
          const newMin = ethers.parseEther("0.1");
          await airdrop.setMinDustAmount(newMin);
          assert.equal(await airdrop.getMinDustAmount(), newMin);
        });
      });
      describe("Pledge Phase Additional Tests", function () {
        it("enforces cooldown period between pledges", async () => {
          // Mint and approve tokens
          await tokenA.mint(user1.address, ethers.parseEther("2000"));
          await tokenA
            .connect(user1)
            .approve(await airdrop.getAddress(), ethers.parseEther("2000"));

          // Make first pledge
          await airdrop
            .connect(user1)
            .pledgeTokens(ethers.parseEther("1000"), 0);

          // Try to pledge again immediately - should fail
          await expect(
            airdrop.connect(user1).pledgeTokens(ethers.parseEther("500"), 0)
          ).to.be.revertedWithCustomError(airdrop, "Airdrop__InvalidTimestamp");

          // Fast forward past cooldown period
          const cooldownPeriod = await airdrop.getCooldownPeriod();
          await network.provider.send("evm_increaseTime", [
            Number(cooldownPeriod),
          ]);
          await network.provider.send("evm_mine");

          // Should succeed now
          await expect(
            airdrop.connect(user1).pledgeTokens(ethers.parseEther("500"), 0)
          ).to.not.be.reverted;
        });

        it("enforces pledge deadline", async () => {
          await tokenA.mint(user1.address, ethers.parseEther("1000"));
          await tokenA
            .connect(user1)
            .approve(await airdrop.getAddress(), ethers.parseEther("1000"));

          // Fast forward past pledge deadline
          await network.provider.send("evm_increaseTime", [
            PLEDGE_DURATION + 1,
          ]);
          await network.provider.send("evm_mine");

          await expect(
            airdrop.connect(user1).pledgeTokens(ethers.parseEther("1000"), 0)
          ).to.be.revertedWithCustomError(airdrop, "Airdrop__DeadlinePassed");
        });
        it("respects minScalingRatio parameter", async () => {
          const minScalingRatio = 9000; // 90%

          // Calculate expected total required TokenB for maximum allowed pledge
          const maxPledge = await airdrop.getTokenBMaxCap(); // Get the max cap
          const conversionRatio = await airdrop.getConversionRatio();

          // Calculate pledge amounts that will result in scaling ratio < minScalingRatio
          const maxTokenAAmount =
            (maxPledge * BigInt(10000)) / BigInt(conversionRatio);
          const pledgeAmount1 = maxTokenAAmount / BigInt(2); // Half of max
          const pledgeAmount2 = maxTokenAAmount / BigInt(4); // Quarter of max
          const pledgeAmount3 = maxTokenAAmount / BigInt(4); // Quarter of max

          // Mint tokens for users
          await tokenA.mint(user1.address, pledgeAmount1);
          await tokenA.mint(user2.address, pledgeAmount2);
          await tokenA.mint(user3.address, pledgeAmount3);

          // Approve airdrop contract
          await tokenA
            .connect(user1)
            .approve(await airdrop.getAddress(), pledgeAmount1);
          await tokenA
            .connect(user2)
            .approve(await airdrop.getAddress(), pledgeAmount2);
          await tokenA
            .connect(user3)
            .approve(await airdrop.getAddress(), pledgeAmount3);

          // First pledge
          await expect(
            airdrop.connect(user1).pledgeTokens(pledgeAmount1, minScalingRatio)
          ).to.not.be.reverted;

          // Wait for cooldown
          const cooldownPeriod = await airdrop.getCooldownPeriod();
          await network.provider.send("evm_increaseTime", [
            Number(cooldownPeriod),
          ]);
          await network.provider.send("evm_mine");

          // Second pledge
          await expect(
            airdrop.connect(user2).pledgeTokens(pledgeAmount2, minScalingRatio)
          ).to.not.be.reverted;

          // Calculate current scaling ratio
          const totalPledged = await airdrop.getTotalPledged();
          const requiredTokenB =
            (totalPledged * BigInt(conversionRatio)) / BigInt(10000);
          const currentScalingRatio =
            (maxPledge * BigInt(10000)) / requiredTokenB;

          // Wait for cooldown again
          await network.provider.send("evm_increaseTime", [
            Number(cooldownPeriod),
          ]);
          await network.provider.send("evm_mine");

          // Third pledge should succeed only if current scaling ratio meets minimum
          if (currentScalingRatio >= BigInt(minScalingRatio)) {
            await expect(
              airdrop
                .connect(user3)
                .pledgeTokens(pledgeAmount3, minScalingRatio)
            ).to.not.be.reverted;
          } else {
            await expect(
              airdrop
                .connect(user3)
                .pledgeTokens(pledgeAmount3, minScalingRatio)
            ).to.be.revertedWithCustomError(
              airdrop,
              "Airdrop__ScalingRatioTooLow"
            );
          }
        });
      });

      describe("Distribution Phase Tests", function () {
        it("processes partial batches correctly", async () => {
          // Set up 7 users with pledges
          const testUsers = [user1, user2, user3, user4, user5, user6, user7];
          const pledgeAmount = ethers.parseEther("1000");

          for (let user of testUsers) {
            await tokenA.mint(user.address, pledgeAmount);
            await tokenA
              .connect(user)
              .approve(await airdrop.getAddress(), pledgeAmount);
            await airdrop.connect(user).pledgeTokens(pledgeAmount, 0);
          }

          // Wait for min phase transition time
          const minPhaseTime = await airdrop.getMinPhaseTransitionTime();
          await network.provider.send("evm_increaseTime", [
            Number(minPhaseTime),
          ]);
          await network.provider.send("evm_mine");

          // Enter distribution phase
          await airdrop.finalizePledgePhase();

          // Process first batch of 3
          await airdrop.processPledgeBatch(3);
          expect(await airdrop.getLastProcessedIndex()).to.equal(3);
          expect(await airdrop.getCurrentPhase()).to.equal(1); // DISTRIBUTION

          // Process remaining
          await airdrop.processPledgeBatch(4);
          expect(await airdrop.getLastProcessedIndex()).to.equal(7);
          expect(await airdrop.getCurrentPhase()).to.equal(2); // COMPLETED
        });

        it("calculates token return amounts correctly", async () => {
          // Update max pledge per user
          await airdrop.setMaxPledgePerUser(ethers.parseEther("5000000"));

          // Make initial large pledge to force scaling
          const pledgeAmount = ethers.parseEther("3000000");
          await tokenA.mint(user1.address, pledgeAmount);
          await tokenA
            .connect(user1)
            .approve(await airdrop.getAddress(), pledgeAmount);

          // Record balance before pledge
          const user1BalanceBefore = await tokenA.balanceOf(user1.address);

          // Make pledge
          await airdrop.connect(user1).pledgeTokens(pledgeAmount, 0);

          // Wait for min phase transition time
          const minPhaseTime = await airdrop.getMinPhaseTransitionTime();
          await network.provider.send("evm_increaseTime", [
            Number(minPhaseTime),
          ]);
          await network.provider.send("evm_mine");

          // Finalize and process
          await airdrop.finalizePledgePhase();
          await airdrop.processPledgeBatch(10);

          // Check balances and pledge status
          const user1BalanceAfter = await tokenA.balanceOf(user1.address);
          const userPledge = await airdrop.getUserPledge(user1.address);

          // Verify token return and processing
          expect(user1BalanceAfter).to.be.gt(0);
          expect(userPledge.processed).to.be.true;
        });
      });

      describe("Configuration Tests", function () {
        it("updates minimum phase transition time correctly", async () => {
          const newTransitionTime = 48 * 60 * 60; // 48 hours
          await airdrop.setMinPhaseTransitionTime(newTransitionTime);
          assert.equal(
            await airdrop.getMinPhaseTransitionTime(),
            newTransitionTime
          );
        });

        it("enforces phase transition time restrictions", async () => {
          await airdrop
            .connect(user1)
            .pledgeTokens(ethers.parseEther("1000"), 0);

          // Try to finalize immediately
          await expect(
            airdrop.finalizePledgePhase()
          ).to.be.revertedWithCustomError(
            airdrop,
            "Airdrop__PhaseTransitionTooEarly"
          );

          // Fast forward past minimum time
          const minPhaseTime = await airdrop.getMinPhaseTransitionTime();
          await network.provider.send("evm_increaseTime", [
            Number(minPhaseTime),
          ]);
          await network.provider.send("evm_mine");

          // Should succeed now
          await expect(airdrop.finalizePledgePhase()).to.not.be.reverted;
        });
      });

      describe("Token Recovery Tests", function () {
        it("recovers stuck tokens after completion", async () => {
          // Complete the airdrop first
          await airdrop
            .connect(user1)
            .pledgeTokens(ethers.parseEther("1000"), 0);

          await network.provider.send("evm_increaseTime", [
            Number(await airdrop.getMinPhaseTransitionTime()),
          ]);
          await network.provider.send("evm_mine");

          await airdrop.finalizePledgePhase();
          await airdrop.processPledgeBatch(10);

          // Send some "stuck" tokens to contract
          const stuckAmount = ethers.parseEther("1");
          await tokenA.mint(await airdrop.getAddress(), stuckAmount);

          // Recover tokens
          await expect(
            airdrop.recoverStuckTokens(
              await tokenA.getAddress(),
              owner.address,
              stuckAmount
            )
          ).to.not.be.reverted;
        });

        it("enforces minimum dust amount for recovery", async () => {
          // Complete the airdrop
          await airdrop
            .connect(user1)
            .pledgeTokens(ethers.parseEther("1000"), 0);

          await network.provider.send("evm_increaseTime", [
            Number(await airdrop.getMinPhaseTransitionTime()),
          ]);
          await network.provider.send("evm_mine");

          await airdrop.finalizePledgePhase();
          await airdrop.processPledgeBatch(10);

          const minDust = await airdrop.getMinDustAmount();
          const belowMin = minDust - BigInt(1);

          await expect(
            airdrop.recoverStuckTokens(
              await tokenA.getAddress(),
              owner.address,
              belowMin
            )
          ).to.be.revertedWithCustomError(airdrop, "Airdrop__DustAmountTooLow");
        });
      });

      describe("Calculation Function Tests", function () {
        beforeEach(async () => {
          // Reset max pledge per user to allow larger amounts
          await airdrop.setMaxPledgePerUser(ethers.parseEther("5000000"));
        });
        it("calculates TokenB amount correctly", async () => {
          const tokenAAmount = ethers.parseEther("1000");
          const expected =
            (tokenAAmount * BigInt(CONVERSION_RATIO)) / BigInt(BASIS_POINTS);
          const calculated = await airdrop.calculateTokenBAmount(tokenAAmount);
          assert.equal(calculated, expected);
        });

        it("calculates scaled TokenB amount correctly", async () => {
          const tokenAAmount = ethers.parseEther("1000");

          // Make a large pledge to force scaling
          await tokenA.mint(user1.address, ethers.parseEther("3000000"));
          await tokenA
            .connect(user1)
            .approve(await airdrop.getAddress(), ethers.parseEther("3000000"));
          await airdrop
            .connect(user1)
            .pledgeTokens(ethers.parseEther("3000000"), 0);

          // Wait and finalize
          await network.provider.send("evm_increaseTime", [
            Number(await airdrop.getMinPhaseTransitionTime()),
          ]);
          await network.provider.send("evm_mine");
          await airdrop.finalizePledgePhase();

          // Get the actual scaling ratio after finalization
          const actualScalingRatio = await airdrop.getScalingRatio();

          // Calculate expected scaled amount
          const rawAmount = await airdrop.calculateTokenBAmount(tokenAAmount);
          const scaledAmount = await airdrop.calculateScaledTokenBAmount(
            tokenAAmount
          );
          const expected =
            (rawAmount * actualScalingRatio) / BigInt(BASIS_POINTS);

          expect(scaledAmount).to.equal(expected);
        });
      });

      describe("Edge Cases", function () {
        it("handles token decimal incompatibility", async () => {
          const TokenMock = await ethers.getContractFactory("ERC20Mock");
          const tokenC = await TokenMock.deploy("Token C", "TKC", 6); // Different decimals

          await expect(
            ethers.deployContract("Airdrop", [
              await tokenA.getAddress(),
              await tokenC.getAddress(),
              CONVERSION_RATIO,
              TOKEN_B_MAX_CAP,
              MIN_PLEDGE_AMOUNT,
              PLEDGE_DURATION,
            ])
          ).to.be.revertedWithCustomError(
            airdrop,
            "Airdrop__IncompatibleDecimals"
          );
        });

        it("validates zero amount handling", async () => {
          await expect(
            airdrop.connect(user1).pledgeTokens(0, 0)
          ).to.be.revertedWithCustomError(
            airdrop,
            "Airdrop__PledgeAmountTooLow"
          );

          const zeroCalculation = await airdrop.calculateTokenBAmount(0);
          assert.equal(zeroCalculation, 0);
        });

        it("handles maximum integer values", async () => {
          const maxUint256 = ethers.MaxUint256;

          // Should revert due to multiplication overflow
          await expect(airdrop.calculateTokenBAmount(maxUint256)).to.be
            .reverted;

          // Test with a very large but safe number
          const largeAmount = ethers.parseEther("1000000000"); // 1 billion tokens
          await expect(airdrop.calculateTokenBAmount(largeAmount)).to.not.be
            .reverted;
        });
      });
    });
