// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

error Airdrop__NotInPledgePhase();
error Airdrop__NotInDistributionPhase();
error Airdrop__PledgeAmountTooLow();
error Airdrop__PledgeAmountTooLarge();
error Airdrop__AlreadyProcessed();
error Airdrop__ScalingRatioTooLow();
error Airdrop__DeadlinePassed();
error Airdrop__InvalidAddress();
error Airdrop__InvalidAmount();
error Airdrop__EmergencyOnly();
error Airdrop__InvalidTimestamp();
error Airdrop__ContractPaused();
error Airdrop__PhaseTransitionTooEarly();
error Airdrop__IncompatibleDecimals();
error Airdrop__MaxPledgeExceeded();
error Airdrop__DustAmountTooLow();

/**
 * @title Airdrop
 * @dev Implements a secure two-phase airdrop system with pledge and distribution phases
 * Features include emergency withdrawal, pausability, and SafeERC20 implementation
 */
contract Airdrop is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    /* Types */
    enum AirdropPhase {
        PLEDGE,
        DISTRIBUTION,
        COMPLETED
    }

    struct UserPledge {
        uint256 tokenAAmount;
        uint256 tokenBAllocation;
        bool processed;
        uint256 timestamp;
    }

    /* State Variables */
    // Immutable variables
    IERC20 private immutable i_tokenA;
    IERC20 private immutable i_tokenB;
    uint256 private immutable i_conversionRatio;
    uint256 private immutable i_tokenBMaxCap;
    uint256 private immutable i_minPledgeAmount;
    uint8 private immutable i_tokenADecimals;
    uint8 private immutable i_tokenBDecimals;

    /* Storage variables */
    uint256 private s_lastProcessedIndex;
    uint256 private s_pledgeDeadline;
    uint256 private s_lastPhaseTransition;
    uint256 private s_maxPledgePerUser;
    uint256 private s_minDustAmount;
    AirdropPhase private s_currentPhase;
    uint256 private s_totalTokenAPledged;
    uint256 private s_scalingRatio;
    address[] private s_pledgers;
    mapping(address => UserPledge) private s_userPledges;

    // Security variables
    bool private s_emergencyMode;
    uint256 private s_cooldownPeriod;
    uint256 private s_minPhaseTransitionTime;
    mapping(address => bool) private s_blacklistedAddresses;

    /* Constants */
    uint256 private constant BASIS_POINTS = 10000;
    uint256 private constant BATCH_SIZE = 100;
    uint256 private constant MIN_SCALING_RATIO = BASIS_POINTS / 10;
    uint256 private constant MAX_INT = type(uint256).max;
    uint256 private constant DEFAULT_COOLDOWN = 1 hours;
    uint256 private constant DEFAULT_MIN_PHASE_TRANSITION = 24 hours;
    uint256 private constant DEFAULT_MAX_PLEDGE = 1000000e18;
    uint256 private constant DEFAULT_MIN_DUST = 1e15;

    /* Events */
    event PledgeSubmitted(
        address indexed user,
        uint256 tokenAAmount,
        uint256 timestamp
    );
    event PhaseUpdated(AirdropPhase newPhase);
    event TokensDistributed(
        address indexed user,
        uint256 tokenBAmount,
        uint256 tokenAReturned
    );
    event ScalingRatioSet(uint256 scalingRatio);
    event EmergencyModeActivated(address indexed activator);
    event AddressBlacklisted(address indexed account, bool status);
    event EmergencyWithdrawal(
        address indexed token,
        address indexed recipient,
        uint256 amount
    );
    event CooldownPeriodUpdated(uint256 newPeriod);
    event MaxPledgePerUserUpdated(uint256 newAmount);
    event MinDustAmountUpdated(uint256 newAmount);
    event StuckTokensRecovered(
        address indexed token,
        address indexed recipient,
        uint256 amount
    );
    event MinPhaseTransitionTimeUpdated(uint256 newTime);

    // Modifiers 
    modifier notBlacklisted() {
        if (s_blacklistedAddresses[msg.sender])
            revert Airdrop__InvalidAddress();
        _;
    }

    modifier whenNotEmergency() {
        if (s_emergencyMode) revert Airdrop__EmergencyOnly();
        if (paused()) revert EnforcedPause();
        _;
    }
    modifier checkPhaseTransitionTime() {
        if (
            block.timestamp < s_lastPhaseTransition + s_minPhaseTransitionTime
        ) {
            revert Airdrop__PhaseTransitionTooEarly();
        }
        _;
    }

    constructor(
        address tokenA,
        address tokenB,
        uint256 conversionRatio,
        uint256 tokenBMaxCap,
        uint256 minPledgeAmount,
        uint256 pledgeDuration
    ) Ownable(msg.sender) {
        if (tokenA == address(0) || tokenB == address(0))
            revert Airdrop__InvalidAddress();
        if (conversionRatio == 0 || conversionRatio > 1e18)
            revert Airdrop__InvalidAmount();
        if (minPledgeAmount == 0) revert Airdrop__InvalidAmount();
        if (pledgeDuration == 0) revert Airdrop__InvalidTimestamp();

        i_tokenA = IERC20(tokenA);
        i_tokenB = IERC20(tokenB);

        // Check token decimals compatibility
        i_tokenADecimals = IERC20Metadata(tokenA).decimals();
        i_tokenBDecimals = IERC20Metadata(tokenB).decimals();
        if (i_tokenADecimals != i_tokenBDecimals)
            revert Airdrop__IncompatibleDecimals();

        i_conversionRatio = conversionRatio;
        i_tokenBMaxCap = tokenBMaxCap;
        i_minPledgeAmount = minPledgeAmount;
        s_pledgeDeadline = block.timestamp + pledgeDuration;
        s_currentPhase = AirdropPhase.PLEDGE;
        s_cooldownPeriod = DEFAULT_COOLDOWN;
        s_minPhaseTransitionTime = DEFAULT_MIN_PHASE_TRANSITION;
        s_maxPledgePerUser = DEFAULT_MAX_PLEDGE;
        s_minDustAmount = DEFAULT_MIN_DUST;
        s_lastPhaseTransition = block.timestamp;
    }

    /**
     * @dev Allows users to pledge TokenA during the pledge phase
     * @param amount Amount of TokenA to pledge
     */
    function pledgeTokens(
        uint256 amount,
        uint256 minScalingRatio
    ) external nonReentrant whenNotPaused whenNotEmergency notBlacklisted {
        if (s_currentPhase != AirdropPhase.PLEDGE)
            revert Airdrop__NotInPledgePhase();
        if (block.timestamp > s_pledgeDeadline)
            revert Airdrop__DeadlinePassed();
        if (amount < i_minPledgeAmount) revert Airdrop__PledgeAmountTooLow();
        if (amount > MAX_INT / i_conversionRatio)
            revert Airdrop__PledgeAmountTooLarge();
            
        /* Only check scaling ratio if it has been set (after first finalizePledgePhase) */
        if (s_currentPhase == AirdropPhase.PLEDGE && s_scalingRatio != 0) {
            if (s_scalingRatio < minScalingRatio)
                revert Airdrop__ScalingRatioTooLow();
        }

        UserPledge storage userPledge = s_userPledges[msg.sender];

        // Check maximum pledge amount
        if (userPledge.tokenAAmount + amount > s_maxPledgePerUser) {
            revert Airdrop__MaxPledgeExceeded();
        }

        // Check cooldown period
        if (
            userPledge.timestamp != 0 &&
            block.timestamp - userPledge.timestamp < s_cooldownPeriod
        ) {
            revert Airdrop__InvalidTimestamp();
        }

        if (userPledge.tokenAAmount == 0) {
            s_pledgers.push(msg.sender);
        }

        userPledge.tokenAAmount += amount;
        userPledge.timestamp = block.timestamp;
        s_totalTokenAPledged += amount;

        i_tokenA.safeTransferFrom(msg.sender, address(this), amount);
        emit PledgeSubmitted(msg.sender, amount, block.timestamp);
    }


    /**
     * @dev Moves to distribution phase and calculates scaling ratio if needed
     */
    function finalizePledgePhase()
        external
        onlyOwner
        whenNotPaused
        whenNotEmergency
        checkPhaseTransitionTime
    {
        if (s_currentPhase != AirdropPhase.PLEDGE)
            revert Airdrop__NotInPledgePhase();

        uint256 totalTokenBRequired = (s_totalTokenAPledged *
            i_conversionRatio) / BASIS_POINTS;

        if (totalTokenBRequired > i_tokenBMaxCap) {
            // Calculate scaling ratio: (maxCap * BASIS_POINTS) / totalRequired
            s_scalingRatio =
                (i_tokenBMaxCap * BASIS_POINTS) /
                totalTokenBRequired;

            /* Ensure scaling ratio doesn't go below minimum */
            if (s_scalingRatio < MIN_SCALING_RATIO) {
                s_scalingRatio = MIN_SCALING_RATIO;
            }
        } else {
            s_scalingRatio = BASIS_POINTS; // 100% if under max cap
        }

        s_currentPhase = AirdropPhase.DISTRIBUTION;
        s_lastPhaseTransition = block.timestamp;

        emit PhaseUpdated(AirdropPhase.DISTRIBUTION);
        emit ScalingRatioSet(s_scalingRatio);
    }

    /**
     * @dev Process a batch of pledges during distribution phase
     * @param batchSize Number of pledges to process in this batch
     */
    function processPledgeBatch(
        uint256 batchSize
    ) external onlyOwner nonReentrant whenNotPaused whenNotEmergency {
        if (s_currentPhase != AirdropPhase.DISTRIBUTION)
            revert Airdrop__NotInDistributionPhase();

        uint256 endIndex = s_lastProcessedIndex + batchSize;
        if (endIndex > s_pledgers.length) {
            endIndex = s_pledgers.length;
        }

        uint256 gasThreshold = (block.gaslimit * 10) / 100;

        for (
            uint256 i = s_lastProcessedIndex;
            i < endIndex && gasleft() > gasThreshold;

        ) {
            address pledger = s_pledgers[i];
            UserPledge storage pledge = s_userPledges[pledger];

            if (
                !pledge.processed &&
                pledge.tokenAAmount > 0 &&
                !s_blacklistedAddresses[pledger]
            ) {
                _processPledge(pledger, pledge);
            }

            unchecked {
                ++i;
            }
        }

        s_lastProcessedIndex = endIndex;

        if (s_lastProcessedIndex == s_pledgers.length) {
            s_currentPhase = AirdropPhase.COMPLETED;
            emit PhaseUpdated(AirdropPhase.COMPLETED);
        }
    }

    /* Security Functions */

    /**
     * @dev Activates emergency mode to halt all non-emergency operations
     */
    function activateEmergencyMode() external onlyOwner {
        if (!s_emergencyMode) {
            s_emergencyMode = true;
            _pause();
            emit EmergencyModeActivated(msg.sender);
        }
    }

    /**
     * @dev Emergency withdrawal of tokens in case of critical issues
     */
    function emergencyWithdraw(
        address token,
        address recipient,
        uint256 amount
    ) external onlyOwner {
        if (!s_emergencyMode) revert Airdrop__EmergencyOnly();
        if (recipient == address(0)) revert Airdrop__InvalidAddress();

        IERC20(token).safeTransfer(recipient, amount);
        emit EmergencyWithdrawal(token, recipient, amount);
    }

    /**
     * @dev Recover stuck tokens after distribution is complete
     */
    function recoverStuckTokens(
        address token,
        address recipient,
        uint256 amount
    ) external onlyOwner {
        if (s_currentPhase != AirdropPhase.COMPLETED)
            revert Airdrop__NotInDistributionPhase();
        if (recipient == address(0)) revert Airdrop__InvalidAddress();
        if (amount < s_minDustAmount) revert Airdrop__DustAmountTooLow();

        IERC20(token).safeTransfer(recipient, amount);
        emit StuckTokensRecovered(token, recipient, amount);
    }

    /**
     * @dev Blacklist addresses that show suspicious behavior
     */
    function setBlacklistStatus(
        address account,
        bool status
    ) external onlyOwner {
        s_blacklistedAddresses[account] = status;
        emit AddressBlacklisted(account, status);
    }

    /**
     * @dev Set maximum pledge amount per user
     */
    function setMaxPledgePerUser(uint256 newAmount) external onlyOwner {
        if (newAmount == 0) revert Airdrop__InvalidAmount();
        s_maxPledgePerUser = newAmount;
        emit MaxPledgePerUserUpdated(newAmount);
    }

    /**
     * @dev Set minimum dust amount for token recovery
     */
    function setMinDustAmount(uint256 newAmount) external onlyOwner {
        s_minDustAmount = newAmount;
        emit MinDustAmountUpdated(newAmount);
    }

    /**
     * @dev Set minimum time between phase transitions
     */
    function setMinPhaseTransitionTime(uint256 newTime) external onlyOwner {
        s_minPhaseTransitionTime = newTime;
        emit MinPhaseTransitionTimeUpdated(newTime);
    }

    /**
     * @dev Update cooldown period between pledges
     */
    function setCooldownPeriod(uint256 newPeriod) external onlyOwner {
        s_cooldownPeriod = newPeriod;
        emit CooldownPeriodUpdated(newPeriod);
    }

    /* Internal Functions */

    function _processPledge(
        address pledger,
        UserPledge storage pledge
    ) internal {
        uint256 scaledTokenBAmount = calculateScaledTokenBAmount(
            pledge.tokenAAmount
        );
        uint256 tokenAToReturn = calculateTokenAToReturn(
            pledge.tokenAAmount,
            scaledTokenBAmount
        );

        pledge.tokenBAllocation = scaledTokenBAmount;
        pledge.processed = true;

        if (scaledTokenBAmount > 0) {
            i_tokenB.safeTransfer(pledger, scaledTokenBAmount);
        }

        if (tokenAToReturn > 0) {
            i_tokenA.safeTransfer(pledger, tokenAToReturn);
        }

        emit TokensDistributed(pledger, scaledTokenBAmount, tokenAToReturn);
    }

    /* View Functions */

    function calculateTokenBAmount(
        uint256 tokenAAmount
    ) public view returns (uint256) {
        return (tokenAAmount * i_conversionRatio) / BASIS_POINTS;
    }

    function calculateScaledTokenBAmount(
        uint256 tokenAAmount
    ) public view returns (uint256) {
        uint256 rawAmount = calculateTokenBAmount(tokenAAmount);
        return (rawAmount * s_scalingRatio) / BASIS_POINTS;
    }

    function calculateTokenAToReturn(
        uint256 tokenAAmount,
        uint256 scaledTokenBAmount
    ) public view returns (uint256) {
        if (s_scalingRatio < BASIS_POINTS) {
            uint256 effectiveTokenB = (scaledTokenBAmount * BASIS_POINTS) /
                s_scalingRatio;
            return tokenAAmount - effectiveTokenB;
        }
        return 0;
    }

    /* Getter Functions */

    function getCurrentPhase() external view returns (AirdropPhase) {
        return s_currentPhase;
    }

    function getUserPledge(
        address user
    )
        external
        view
        returns (
            uint256 tokenAAmount,
            uint256 tokenBAllocation,
            bool processed,
            uint256 timestamp
        )
    {
        UserPledge memory pledge = s_userPledges[user];
        return (
            pledge.tokenAAmount,
            pledge.tokenBAllocation,
            pledge.processed,
            pledge.timestamp
        );
    }

    function isBlacklisted(address account) external view returns (bool) {
        return s_blacklistedAddresses[account];
    }

    function getTotalPledged() external view returns (uint256) {
        return s_totalTokenAPledged;
    }

    function getScalingRatio() external view returns (uint256) {
        return s_scalingRatio;
    }

    function getConversionRatio() external view returns (uint256) {
        return i_conversionRatio;
    }

    function getTokenBMaxCap() external view returns (uint256) {
        return i_tokenBMaxCap;
    }

    function getPledgersCount() external view returns (uint256) {
        return s_pledgers.length;
    }

    function getPledgeDeadline() external view returns (uint256) {
        return s_pledgeDeadline;
    }

    function getLastProcessedIndex() external view returns (uint256) {
        return s_lastProcessedIndex;
    }

    function getCooldownPeriod() external view returns (uint256) {
        return s_cooldownPeriod;
    }

    function getMaxPledgePerUser() external view returns (uint256) {
        return s_maxPledgePerUser;
    }

    function getMinDustAmount() external view returns (uint256) {
        return s_minDustAmount;
    }

    function getMinPhaseTransitionTime() external view returns (uint256) {
        return s_minPhaseTransitionTime;
    }

    function getLastPhaseTransition() external view returns (uint256) {
        return s_lastPhaseTransition;
    }

    function getTokenDecimals() external view returns (uint8, uint8) {
        return (i_tokenADecimals, i_tokenBDecimals);
    }

    function isEmergencyMode() external view returns (bool) {
        return s_emergencyMode;
    }
}
