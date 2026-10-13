package app.swipe.android

import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import java.util.Base64
import java.util.Locale
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// SPAKE2 pairing and the encrypted signaling channel.
// Must match web/js/crypto.js byte for byte; see docs/PROTOCOL.md and the
// shared vectors in docs/test-vectors.json (checked by PakeTest).

object Group {
    val P = BigInteger(
        "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aacaa68ffffffffffffffff",
        16,
    )
    val Q: BigInteger = P.subtract(BigInteger.ONE).shiftRight(1)
    val G: BigInteger = BigInteger.valueOf(2)
    val M = BigInteger(
        "4e8bcbcd6027c51d25c4a67455821583123238f421d6151584d264ab765dd2d6685f2652844df349d01c6bd2ada22d4ce2331be4a695416badaa9926f289c93098cb92ee73af2d3570066d145432e0c025ba3c23fc7e66c7c2aaa3cb6c41fa3a09ba71fee3f8a1012a9e824c4d21246c50e368e9f7ec066c0cc7d0cf800b734ce59c893d7995b523ecb668a98e76a09117cac5e7c726cc7bba279fe9700a01987f27013b26d2a516295500d67474092b6d7fb068229a1a824fd7ba2b0556466d52cccd1f9e9cda12d0fef2792f55d2cd8ac213b17fa292fdb2b061575fdd18365f010b121725ff03bb36948657b8d97b525a5b142920abfcc2b2c79077f88055",
        16,
    )
    val N = BigInteger(
        "5b41daf0c14a2106a4e789f111c2b3a4a3e4df3261c7fa816b2e424db2ec9af3c715d46d8c0d4c43264cd41870253dfe0a06f63fac7825464081f041cb990ea484fe3a6e514a4bc0db49d390325fa0eba52356083d073e5bd76f75ee35c30bb92b542daa575b8f06916e17c8cbea9d5b966c7fa1bdeb262e81a138c26a41b097e2e5920421bfee4cb74b6fff4287fbf6cd4d543e0be12eafda0f6f69f882062f764b468c08c8f697351c7bdc72d66b434700839f8e9a8cb87c0d3f527a808dc08731f706617a965f673c5881934d4ef2d11045b37e3662037b7423154ef20893c6c4d0122dd283d026cf5d504568c0c6411c5a86df61d86aeb0ad29ec39a9b27",
        16,
    )
    const val ELEMENT_BYTES = 256

    fun isValidElement(e: BigInteger): Boolean =
        e > BigInteger.ONE && e < P.subtract(BigInteger.ONE) && e.modPow(Q, P) == BigInteger.ONE
}

private const val LABEL = "swipe-pake-v1"
private val random = SecureRandom()

object Codes {
    fun normalizeCode(code: String): String = code.filter { it in '0'..'9' }

    fun normalizePassword(pw: String): String =
        Normalizer.normalize(pw, Normalizer.Form.NFKC).replace(Regex("[ \t\r\n-]"), "").uppercase(Locale.ROOT)

    private const val ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

    fun generatePassword(len: Int = 8): String {
        val sb = StringBuilder()
        while (sb.length < len) {
            val b = random.nextInt(256)
            if (b < 248) sb.append(ALPHABET[b % ALPHABET.length])
        }
        return sb.toString()
    }

    fun formatCode(code: String): String = normalizeCode(code).chunked(3).joinToString(" ")

    fun formatPassword(pw: String): String {
        val n = normalizePassword(pw)
        return if (n.length == 8) n.substring(0, 4) + "-" + n.substring(4) else n
    }
}

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

fun String.hexToBytes(): ByteArray {
    require(length % 2 == 0 && all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) { "bad hex" }
    return ByteArray(length / 2) { substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

/** Big-endian, fixed length, unsigned. */
fun BigInteger.toFixedBytes(len: Int): ByteArray {
    val raw = toByteArray()
    val start = if (raw.size > len) raw.size - len else 0
    require(raw.size - start <= len && raw.copyOfRange(0, start).all { it == 0.toByte() }) { "integer too large" }
    val out = ByteArray(len)
    System.arraycopy(raw, start, out, len - (raw.size - start), raw.size - start)
    return out
}

private fun sha256(vararg parts: ByteArray): ByteArray {
    val md = MessageDigest.getInstance("SHA-256")
    for (p in parts) md.update(p)
    return md.digest()
}

private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(data)
}

/** RFC 5869 HKDF-SHA256 with an empty salt, 32-byte output. */
private fun hkdf(ikm: ByteArray, info: String): ByteArray {
    val prk = hmac(ByteArray(32), ikm) // empty salt == HashLen zero bytes
    return hmac(prk, info.toByteArray(Charsets.UTF_8) + byteArrayOf(1))
}

fun passwordScalar(code: String, password: String): BigInteger {
    val digest = sha256(
        LABEL.toByteArray(), byteArrayOf(0),
        Codes.normalizeCode(code).toByteArray(), byteArrayOf(0),
        Codes.normalizePassword(password).toByteArray(Charsets.UTF_8),
    )
    return BigInteger(1, digest)
}

class PakeException(message: String) : Exception(message)

/** role: "viewer" (sends X, masks with M) or "host" (sends Y, masks with N). */
class Spake2(private val role: String, code: String, private val password: String, private val testScalar: BigInteger? = null) {
    private val code = Codes.normalizeCode(code)
    private var w: BigInteger = BigInteger.ZERO
    private var x: BigInteger = BigInteger.ZERO
    private var mine: BigInteger = BigInteger.ZERO
    private var peerConfirm: ByteArray = ByteArray(0)
    var transcript: ByteArray = ByteArray(0)
        private set
    var keyV2H: ByteArray = ByteArray(0)
        private set
    var keyH2V: ByteArray = ByteArray(0)
        private set

    init {
        require(role == "viewer" || role == "host")
    }

    fun start(): String {
        w = passwordScalar(code, password)
        x = testScalar ?: run {
            var v: BigInteger
            do v = BigInteger(1, ByteArray(40).also { random.nextBytes(it) }) while (v.signum() == 0)
            v
        }
        val mask = if (role == "viewer") Group.M else Group.N
        mine = Group.G.modPow(x, Group.P).multiply(mask.modPow(w, Group.P)).mod(Group.P)
        return mine.toFixedBytes(Group.ELEMENT_BYTES).toHex()
    }

    /** Returns this side's confirmation MAC (hex). */
    fun finish(peerHex: String): String {
        if (peerHex.length != Group.ELEMENT_BYTES * 2) throw PakeException("bad element")
        val peer = BigInteger(1, try { peerHex.hexToBytes() } catch (e: IllegalArgumentException) { throw PakeException("bad element") })
        if (!Group.isValidElement(peer)) throw PakeException("invalid element")
        val peerMask = if (role == "viewer") Group.N else Group.M
        val unmasked = peer.multiply(peerMask.modPow(Group.Q.subtract(w.mod(Group.Q)), Group.P)).mod(Group.P)
        val k = unmasked.modPow(x, Group.P)
        val bigX = if (role == "viewer") mine else peer
        val bigY = if (role == "viewer") peer else mine
        val tt = sha256(
            LABEL.toByteArray(), byteArrayOf(0),
            code.toByteArray(), byteArrayOf(0),
            bigX.toFixedBytes(Group.ELEMENT_BYTES),
            bigY.toFixedBytes(Group.ELEMENT_BYTES),
            k.toFixedBytes(Group.ELEMENT_BYTES),
            w.toFixedBytes(32),
        )
        transcript = tt
        val kcViewer = hkdf(tt, "swipe/confirm/viewer")
        val kcHost = hkdf(tt, "swipe/confirm/host")
        keyV2H = hkdf(tt, "swipe/enc/v2h")
        keyH2V = hkdf(tt, "swipe/enc/h2v")
        peerConfirm = hmac(if (role == "viewer") kcHost else kcViewer, tt)
        x = BigInteger.ZERO
        return hmac(if (role == "viewer") kcViewer else kcHost, tt).toHex()
    }

    fun verify(peerConfirmHex: String?): Boolean {
        if (peerConfirmHex == null || peerConfirmHex.length != 64) return false
        val given = try { peerConfirmHex.hexToBytes() } catch (e: IllegalArgumentException) { return false }
        return MessageDigest.isEqual(given, peerConfirm)
    }

    fun channel(): SecureChannel =
        if (role == "viewer") SecureChannel(keyV2H, keyH2V) else SecureChannel(keyH2V, keyV2H)
}

/** AES-256-GCM with per-direction keys and strict message counters. */
class SecureChannel(sendKey: ByteArray, recvKey: ByteArray) {
    private val sendKey = SecretKeySpec(sendKey, "AES")
    private val recvKey = SecretKeySpec(recvKey, "AES")
    private var sendCounter = 0L
    private var recvCounter = 0L

    private fun nonce(n: Long): ByteArray = ByteBuffer.allocate(12).putInt(0).putLong(n).array()

    data class Sealed(val n: Long, val c: String)

    @Synchronized
    fun seal(plainJson: String): Sealed {
        val n = sendCounter++
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, sendKey, GCMParameterSpec(128, nonce(n)))
        cipher.updateAAD(AAD)
        return Sealed(n, Base64.getEncoder().encodeToString(cipher.doFinal(plainJson.toByteArray(Charsets.UTF_8))))
    }

    @Synchronized
    fun open(n: Long, c: String): String {
        if (n != recvCounter) throw PakeException("out-of-order secure message")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, recvKey, GCMParameterSpec(128, nonce(n)))
        cipher.updateAAD(AAD)
        val plain = cipher.doFinal(Base64.getDecoder().decode(c))
        recvCounter++
        return String(plain, Charsets.UTF_8)
    }

    companion object {
        private val AAD = "swipe/v1".toByteArray()
    }
}
