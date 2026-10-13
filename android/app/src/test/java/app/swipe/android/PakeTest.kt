package app.swipe.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.math.BigInteger

class PakeTest {
    private fun vectors(): JSONObject {
        // Gradle runs unit tests from the module directory (android/app).
        val candidates = listOf("../../docs/test-vectors.json", "../docs/test-vectors.json", "docs/test-vectors.json")
        val file = candidates.map { File(it) }.first { it.exists() }
        return JSONObject(file.readText())
    }

    @Test
    fun matchesSharedTestVectors() {
        val list = vectors().getJSONArray("spake2")
        for (i in 0 until list.length()) {
            val tv = list.getJSONObject(i)
            val code = tv.getString("code")
            val pw = tv.getString("password")
            assertEquals(tv.getString("w"), passwordScalar(code, pw).toFixedBytes(32).toHex())
            val v = Spake2("viewer", code, pw, BigInteger(tv.getString("x"), 16))
            val h = Spake2("host", code, pw, BigInteger(tv.getString("y"), 16))
            assertEquals(tv.getString("X"), v.start())
            assertEquals(tv.getString("Y"), h.start())
            assertEquals(tv.getString("confirmHost"), h.finish(tv.getString("X")))
            assertEquals(tv.getString("confirmViewer"), v.finish(tv.getString("Y")))
            assertEquals(tv.getString("transcript"), v.transcript.toHex())
            assertEquals(tv.getString("keyV2H"), v.keyV2H.toHex())
            assertEquals(tv.getString("keyH2V"), v.keyH2V.toHex())
            assertTrue(v.verify(tv.getString("confirmHost")))
            assertTrue(h.verify(tv.getString("confirmViewer")))

            val msg = tv.getJSONObject("message")
            val sealed = v.channel().seal(msg.getString("plainJson"))
            assertEquals(msg.getJSONObject("sealed").getLong("n"), sealed.n)
            assertEquals(msg.getJSONObject("sealed").getString("c"), sealed.c)
            // The host can open what the viewer sealed.
            assertEquals(msg.getString("plainJson"), h.channel().open(sealed.n, sealed.c))
        }
    }

    @Test
    fun wrongPasswordFails() {
        val v = Spake2("viewer", "123456789", "abcdefgh")
        val h = Spake2("host", "123456789", "abcdefgx")
        val x = v.start()
        val y = h.start()
        val ch = h.finish(x)
        val cv = v.finish(y)
        assertFalse(v.verify(ch))
        assertFalse(h.verify(cv))
    }

    @Test
    fun normalization() {
        assertEquals("K7M2PX9Q", Codes.normalizePassword(" k7m2-px9q "))
        assertEquals("ABC", Codes.normalizePassword("ａｂｃ"))
        assertEquals("123 456 789", Codes.formatCode("123456789"))
        assertTrue(Codes.generatePassword().matches(Regex("[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}")))
    }

    @Test(expected = PakeException::class)
    fun rejectsIdentityElement() {
        val h = Spake2("host", "123456789", "pw")
        h.start()
        h.finish("0".repeat(511) + "1")
    }
}
